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
				`import homePage from './public/index.html';\n` +
				`import welcomeContent from './public/welcome.html';\n` +
				`import { handleTurnstileRequest } from './src/turnstile.js';\n`,
			);

			// ② 本地开发专属注入（由 WRANGLER_LOCAL=true 控制）
			if (process.env.WRANGLER_LOCAL === 'true') {
				const httpRedirect = `if (url.protocol === 'http:') return Response.redirect`;
				const redirectIdx = code.indexOf(httpRedirect);
				if (redirectIdx !== -1) {
					s.overwrite(
						redirectIdx,
						redirectIdx + `if (url.protocol === 'http:')`.length,
						`if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')`,
					);
				}
			}

			// ③ fetch 入口：Turnstile 处理 + 本地 reset 调试接口
			const fetchTarget = `async fetch(request, env, ctx) {`;
			const fetchIdx = code.indexOf(fetchTarget);
			if (fetchIdx !== -1) {
				const turnstileBlock =
					`\n\t\t// Turnstile 处理（内部判断是否启用）
	\t\t{\n` +
					`\t\t\tconst turnstileRes = await handleTurnstileRequest(request, env);\n` +
					`\t\t\tif (turnstileRes !== null) return turnstileRes;\n` +
					`\t\t}\n`;

				const resetBlock = process.env.WRANGLER_LOCAL === 'true'
					? `\n\t\t// 本地调试：清除 Turnstile 验证状态\n` +
					  `\t\tif (new URL(request.url).pathname === '/turnstile/reset') return new Response(null, { status: 302, headers: { 'Location': '/', 'Set-Cookie': 'ts_verified=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' } });\n`
					: '';

				s.prependRight(fetchIdx + fetchTarget.length, turnstileBlock + resetBlock);
			}

			// ④ 排除 custom，使其不被当作外部 URL 处理
			const targetLine = `伪装页URL && 伪装页URL !== 'nginx' && 伪装页URL !== '1101'`;
			const idx = code.indexOf(targetLine);
			if (idx !== -1) {
				s.prependRight(
					idx + targetLine.length,
					` && 伪装页URL !== 'custom'`,
				);
			}

			// ⑤ 在 1101 处理之后插入 custom 处理
			const targetBlock = `if (伪装页URL === '1101') return new Response(await html1101(url.host, 访问IP), { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });`;
			const blockIdx = code.indexOf(targetBlock);
			if (blockIdx !== -1) {
				s.prependRight(
					blockIdx + targetBlock.length,
					`\n\t\tif (伪装页URL === 'custom') return await htmlCustom(url);`,
				);
			}

			// ⑥ 在文件末尾追加 htmlCustom 函数
			s.append(
				`\nasync function htmlCustom(url) {\n` +
				`\tif (url.pathname === '/welcome') return new Response(welcomeContent, { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });\n` +
				`\treturn new Response(homePage, { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });\n` +
				`}\n`,
			);

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