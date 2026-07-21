import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';

const IMAGE_DIRECTORY_ENTRY_RESOURCE = 2;
const IMAGE_DIRECTORY_ENTRY_BASE_RELOCATION = 5;
const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;

/**
 * `bun build --compile` appends a small `.bun` marker section after `.reloc`,
 * followed by the actual embedded-asset payload as a raw, section-table-less
 * overlay running to EOF. `pe-library`'s `NtExecutableResource.from` refuses
 * to touch the resource section whenever anything other than `.reloc` follows
 * it, because rewriting resources shifts everything after them and it only
 * knows how to re-home `.reloc` automatically.
 *
 * The underlying `NtExecutable` class is not actually limited that way — it
 * repositions every section generically and re-appends trailing "extra data"
 * verbatim (verified: after a real resource edit, the relocated `.bun`
 * section and the trailing payload come out byte-for-byte identical to the
 * originals, just shifted). So we only need to get past `NtExecutableResource`'s
 * conservative check, which we do with a `Proxy` that hides the trailing
 * `.bun` section from that one call; every other call still reaches the real
 * `NtExecutable`, which handles the repositioning correctly on its own.
 *
 * @param {import('resedit').NtExecutable} exe
 * @returns {import('resedit').NtExecutable}
 */
export function hide_bun_marker_section(exe) {
	const sections = [...exe.getAllSections()].sort(
		(a, b) => a.info.virtualAddress - b.info.virtualAddress
	);
	const resource_section = exe.getSectionByEntry(IMAGE_DIRECTORY_ENTRY_RESOURCE);
	if (!resource_section) return exe;

	const resource_index = sections.indexOf(resource_section);
	const reloc_section = exe.getSectionByEntry(IMAGE_DIRECTORY_ENTRY_BASE_RELOCATION);
	const trailing = sections.slice(resource_index + 1).filter((s) => s !== reloc_section);

	if (trailing.length === 0) return exe;

	const unrecognized = trailing.filter((s) => s.info.name !== '.bun');
	if (unrecognized.length > 0) {
		throw new Error(
			'@sveltejs/adapter-bun: unrecognized section(s) after the resource section ' +
				`(${unrecognized.map((s) => s.info.name).join(', ')}). This adapter\'s Windows ` +
				'icon/metadata post-processing only knows how to handle the `.bun` marker section ' +
				"from the Bun version it was verified against — the compiled executable's layout " +
				'has changed in a way this adapter does not understand. Please file an issue.'
		);
	}

	return new Proxy(exe, {
		get(target, prop) {
			if (prop === 'getAllSections') {
				return () => target.getAllSections().filter((s) => s.info.name !== '.bun');
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

/**
 * @param {string} version
 * @returns {[number, number, number, number]}
 */
function parse_version(version) {
	const parts = version.split('.').map(Number);
	const valid =
		parts.length > 0 &&
		parts.length <= 4 &&
		parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 0xffff);
	if (!valid) {
		throw new Error(
			`@sveltejs/adapter-bun: invalid \`windows.version\` "${version}" — expected up to ` +
				'4 dot-separated integers between 0 and 65535, e.g. "1.2.3.4".'
		);
	}
	return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
}

/**
 * @typedef {NonNullable<NonNullable<Parameters<import('../index.js').default>[0]>['windows']>} WindowsOptions
 */

/**
 * Post-processes a compiled `bun-windows-*` executable to embed an icon and
 * version metadata, working around Bun silently ignoring `compile.windows`
 * when cross-compiling from a non-Windows host.
 *
 * @param {ArrayBuffer} exe_bytes
 * @param {WindowsOptions} windows
 * @param {ArrayBuffer | null} icon_bytes contents of `windows.icon`, already read by the caller
 * @returns {ArrayBuffer}
 */
export function apply_windows_branding(exe_bytes, windows, icon_bytes) {
	const exe = NtExecutable.from(exe_bytes, { ignoreCert: true });

	if (windows.hideConsole) {
		exe.newHeader.optionalHeader.subsystem = IMAGE_SUBSYSTEM_WINDOWS_GUI;
	}

	const has_resource_edits =
		icon_bytes !== null ||
		windows.title !== undefined ||
		windows.publisher !== undefined ||
		windows.version !== undefined ||
		windows.description !== undefined ||
		windows.copyright !== undefined;

	if (has_resource_edits) {
		const rsrc = NtExecutableResource.from(hide_bun_marker_section(exe));

		if (icon_bytes !== null) {
			const icon_data = Data.IconFile.from(icon_bytes).icons.map((i) => i.data);
			const existing_groups = Resource.IconGroupEntry.fromEntries(rsrc.entries);
			if (existing_groups.length > 0) {
				for (const group of existing_groups) {
					Resource.IconGroupEntry.replaceIconsForResource(
						rsrc.entries,
						group.id,
						group.lang,
						icon_data
					);
				}
			} else {
				Resource.IconGroupEntry.replaceIconsForResource(rsrc.entries, 1, 1033, icon_data);
			}
		}

		const string_overrides = {
			...(windows.title !== undefined && { ProductName: windows.title }),
			...(windows.publisher !== undefined && { CompanyName: windows.publisher }),
			...(windows.description !== undefined && { FileDescription: windows.description }),
			...(windows.copyright !== undefined && { LegalCopyright: windows.copyright })
		};

		const existing_version_infos = Resource.VersionInfo.fromEntries(rsrc.entries);
		const version_infos =
			existing_version_infos.length > 0 ? existing_version_infos : [Resource.VersionInfo.createEmpty()];

		for (const version_info of version_infos) {
			const langs = version_info.getAvailableLanguages();
			const langs_to_use = langs.length > 0 ? langs : [{ lang: 1033, codepage: 1200 }];
			for (const language of langs_to_use) {
				version_info.setStringValues(language, string_overrides);
			}
			if (windows.version !== undefined) {
				const [major, minor, micro, revision] = parse_version(windows.version);
				version_info.setFileVersion(major, minor, micro, revision);
				version_info.setProductVersion(major, minor, micro, revision);
			}
			version_info.outputToResourceEntries(rsrc.entries);
		}

		rsrc.outputResource(exe, false, true);
	}

	return exe.generate();
}
