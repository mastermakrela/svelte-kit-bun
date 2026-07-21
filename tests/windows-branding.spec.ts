import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NtExecutable, NtExecutableResource, Resource } from 'resedit';
import { apply_windows_branding, hide_bun_marker_section } from '../src/windows-brand.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture_entry = join(__dirname, 'fixtures/windows-branding/entry.js');
const icon_path = join(__dirname, 'fixtures/windows-branding/icon.ico');

/**
 * Real, unmocked coverage for `apply_windows_branding`: this cross-compiles an
 * actual `bun-windows-x64` executable (the same layout `@sveltejs/adapter-bun`
 * produces), patches it, and re-parses the result to confirm the icon/version
 * resources genuinely changed and the `.bun` marker + embedded payload Bun
 * relies on at runtime survived byte-for-byte. It does NOT run the resulting
 * executable (no Windows/Wine available here) — only structural verification.
 */
describe('apply_windows_branding against a real cross-compiled executable', () => {
	let tmp_dir: string;
	let original_bytes: ArrayBuffer;

	beforeAll(() => {
		tmp_dir = mkdtempSync(join(tmpdir(), 'windows-branding-test-'));
		const outfile = join(tmp_dir, 'app.exe');
		const build = spawnSync(
			'bun',
			['build', '--compile', '--target=bun-windows-x64', `--outfile=${outfile}`, fixture_entry],
			{ stdio: 'inherit' }
		);
		if (build.status !== 0) {
			throw new Error(`bun build --compile --target=bun-windows-x64 failed (status ${build.status})`);
		}
		original_bytes = readFileSync(outfile).buffer as ArrayBuffer;
	}, 60_000);

	afterAll(() => {
		rmSync(tmp_dir, { recursive: true, force: true });
	});

	test('embeds icon and version metadata, leaving the `.bun` marker section intact', () => {
		const icon_bytes = readFileSync(icon_path).buffer as ArrayBuffer;

		const patched = apply_windows_branding(
			original_bytes,
			{
				title: 'My App',
				publisher: 'Acme',
				version: '1.2.3.4',
				description: 'An app',
				copyright: '© Acme',
				hideConsole: true
			},
			icon_bytes
		);

		const original_exe = NtExecutable.from(original_bytes, { ignoreCert: true });
		const patched_exe = NtExecutable.from(patched, { ignoreCert: true });

		// hideConsole flipped the subsystem to GUI
		expect(original_exe.newHeader.optionalHeader.subsystem).toBe(3); // CUI (console)
		expect(patched_exe.newHeader.optionalHeader.subsystem).toBe(2); // GUI

		const rsrc = NtExecutableResource.from(hide_bun_marker_section(patched_exe));

		const version_infos = Resource.VersionInfo.fromEntries(rsrc.entries);
		expect(version_infos).toHaveLength(1);
		const strings = version_infos[0].getStringValues(version_infos[0].getAvailableLanguages()[0]);
		expect(strings.ProductName).toBe('My App');
		expect(strings.CompanyName).toBe('Acme');
		expect(strings.FileDescription).toBe('An app');
		expect(strings.FileVersion).toBe('1.2.3.4');
		expect(strings.ProductVersion).toBe('1.2.3.4');
		expect(strings.LegalCopyright).toBe('© Acme');

		const icon_groups = Resource.IconGroupEntry.fromEntries(rsrc.entries);
		expect(icon_groups).toHaveLength(1);
		const icon_items = icon_groups[0].getIconItemsFromEntries(rsrc.entries);
		expect(icon_items).toHaveLength(3); // fixture .ico has 16/32/48 frames

		// `.bun` marker section: same size, same content, just relocated —
		// this is what Bun's runtime scans for at startup to find itself.
		const original_bun = original_exe.getAllSections().find((s) => s.info.name === '.bun');
		const patched_bun = patched_exe.getAllSections().find((s) => s.info.name === '.bun');
		expect(original_bun).toBeDefined();
		expect(patched_bun).toBeDefined();
		expect(Buffer.from(patched_bun!.data!).equals(Buffer.from(original_bun!.data!))).toBe(true);

		// the embedded payload trailing `.bun` (Bun's actual asset/module blob)
		// must also survive byte-for-byte, just re-appended after the relocated section.
		const original_extra = original_exe.getExtraData();
		const patched_extra = patched_exe.getExtraData();
		expect(original_extra).not.toBeNull();
		expect(patched_extra).not.toBeNull();
		expect(Buffer.from(patched_extra!).equals(Buffer.from(original_extra!))).toBe(true);
	});

	test('is a no-op on the `.bun` marker + payload when no windows options are given', () => {
		const patched = apply_windows_branding(original_bytes, {}, null);
		const patched_exe = NtExecutable.from(patched, { ignoreCert: true });
		const original_exe = NtExecutable.from(original_bytes, { ignoreCert: true });

		expect(Buffer.from(patched_exe.getExtraData()!).equals(Buffer.from(original_exe.getExtraData()!))).toBe(
			true
		);
	});
});
