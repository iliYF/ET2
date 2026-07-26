import * as esbuild from 'esbuild'
import fs from 'fs'
import MagicString from 'magic-string'

const dynamicCodeModifierPlugin = {
	name: 'dynamic-code-modifier',
	setup(build) {

		build.onLoad({ filter: /\/_worker\.js$/ }, async (args) => {
			if (args.path.includes('node_modules')) return;
			if (!args.path.endsWith('_worker.js')) return;

			let code = await fs.promises.readFile(args.path, 'utf8');
			const s = new MagicString(code);

			// ① 文件顶部注入 import
			s.prepend(
				`import welcome from './public/welcome.html';\n` +
				`import { handleTurnstileRequest } from './src/turnstile.js';\n`,
			);

			// ② fetch 入口：调用统一的 Turnstile 处理函数
			const fetchTarget = `async fetch(request, env, ctx) {`;
			const fetchIdx = code.indexOf(fetchTarget);
			if (fetchIdx !== -1) {
				s.prependRight(
					fetchIdx + fetchTarget.length,
					`\n\t\t// Turnstile 处理（内部判断是否启用）
	\t\t{\n` +
					`\t\t\tconst turnstileRes = await handleTurnstileRequest(request, env);\n` +
					`\t\t\tif (turnstileRes !== null) return turnstileRes;\n` +
					`\t\t}\n`,
				);
			}

			// ③ 排除 custom，使其不被当作外部 URL 处理
			const targetLine = `伪装页URL && 伪装页URL !== 'nginx' && 伪装页URL !== '1101'`;
			const idx = code.indexOf(targetLine);
			if (idx !== -1) {
				s.prependRight(
					idx + targetLine.length,
					` && 伪装页URL !== 'custom'`,
				);
			}

			// ④ 在 1101 处理之后插入 custom 处理
			const targetBlock = `if (伪装页URL === '1101') return new Response(await html1101(url.host, 访问IP), { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });`;
			const blockIdx = code.indexOf(targetBlock);
			if (blockIdx !== -1) {
				s.prependRight(
					blockIdx + targetBlock.length,
					`\n\t\tif (伪装页URL === 'custom') return new Response(welcome, { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });`,
				);
			}

			return {
				contents: s.toString(),
				loader: 'js',
			};
		});
	},
};

await esbuild.build({
	entryPoints: ['_worker.js'],
	bundle: true,
	minify: false,
	format: 'esm',
	charset: 'utf8',
	sourcemap: false,
	outfile: 'dist/_worker.js',
	target: 'es2022',
	loader: {
		'.html': 'text',
	},
	plugins: [dynamicCodeModifierPlugin],
}).catch(() => process.exit(1));