<script>
	import logo from '$lib/logo.svg';
	import pixel from '$lib/pixel.png';
	import greetingUrl from '$lib/greeting.txt?url';

	/** @type {{ data: { sampleMd: string } }} */
	let { data } = $props();
</script>

<svelte:head>
	<link rel="stylesheet" href="/extra.css" />
</svelte:head>

<h1 class="assets-marker">Assets</h1>

<img class="logo" src={logo} alt="logo" data-testid="logo" />
<img class="pixel" src={pixel} alt="pixel" data-testid="pixel" />
<a class="greeting" href={greetingUrl} data-testid="greeting-url">greeting file</a>

<pre data-testid="sample-md">{data.sampleMd}</pre>

<style>
	.assets-marker {
		color: #ff3e00;
		background: url('/favicon.png') no-repeat right center;
	}
	.logo,
	.pixel {
		display: block;
	}
</style>
