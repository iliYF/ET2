/**
 * Cloudflare Turnstile 验证模块
 *
 * 提供 API 接口供前端查询 site key 和验证 token。
 * 验证通过后下发签名 Cookie，后续请求凭 Cookie 跳过验证，避免频繁弹出。
 */

const COOKIE_NAME = 'ts_verified';
const COOKIE_MAX_AGE = 24 * 60 * 60; // 24 小时
const COOKIE_PATH = '/';

/**
 * 判断 Turnstile 是否已启用（需同时配置 site key 和 secret key）
 */
function isTurnstileEnabled(env) {
	return !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

/**
 * 签名服务端 Cookie 值
 * 格式：timestamp:signature
 */
async function _signCookie(timestamp, env) {
	const encoder = new TextEncoder();
	const keyData = encoder.encode(env.TURNSTILE_SECRET_KEY);
	const key = await crypto.subtle.importKey(
		'raw', keyData, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(timestamp));
	const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
	return `${timestamp}:${sigHex}`;
}

/**
 * 校验 Cookie 签名是否有效且未过期
 */
async function _verifyCookie(cookieValue, env) {
	const parts = cookieValue.split(':');
	if (parts.length !== 2) return false;
	const [timestamp, sig] = parts;
	const expectedSig = (await _signCookie(timestamp, env)).split(':')[1];
	if (sig !== expectedSig) return false;
	if (Date.now() - parseInt(timestamp, 10) > COOKIE_MAX_AGE * 1000) return false;
	return true;
}

/**
 * 从请求中提取并校验验证 Cookie
 */
async function _getVerifiedCookie(request, env) {
	const cookies = request.headers.get('Cookie') || '';
	const match = cookies.split(';').map(c => c.trim()).find(c => c.startsWith(COOKIE_NAME + '='));
	if (!match) return null;
	const value = match.split('=')[1];
	if (await _verifyCookie(value, env)) return value;
	return null;
}

/**
 * 生成 Set-Cookie 响应头
 */
function _setCookieHeader(timestamp) {
	return `${COOKIE_NAME}=${timestamp}; Path=${COOKIE_PATH}; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Turnstile 入口处理（在 fetch 入口调用）
 *
 * 处理所有 Turnstile 相关场景：
 *   - GET /turnstile/config  → 返回配置信息，已验证明返回 verified: true
 *   - POST /turnstile/verify → 从 Body 读取 token 验证，成功后下发票据
 *   - 任意请求带 X-Turnstile-Token  → 从 Header 提取 token 验证
 *   - 访问 /login、/admin 等页面时，未验证自动重定向到欢迎页
 *
 * @param {Request} request
 * @param {Object} env
 * @returns {Promise<Response|null>} 需要拦截时返回 Response，否则 null
 */
async function handleTurnstileRequest(request, env) {
	// 未启用时直接放行，不做任何处理
	if (!isTurnstileEnabled(env)) {
		return null;
	}

	const url = new URL(request.url);

	// 1. 配置查询：返回 site key，同时检查是否已验证
	if (url.pathname === '/turnstile/config') {
		const verified = await _getVerifiedCookie(request, env);
		if (verified) {
			return new Response(
				JSON.stringify({enabled: true, verified: true}),
				{headers: {'Content-Type': 'application/json'}},
			);
		}
		return new Response(
			JSON.stringify({enabled: true, siteKey: env.TURNSTILE_SITE_KEY}),
			{headers: {'Content-Type': 'application/json'}},
		);
	}

	// 2. 验证接口：POST /turnstile/verify（从 Body 读取 token，成功后下发票据）
	if (url.pathname === '/turnstile/verify') {
		try {
			const body = await request.json();
			const token = body.token;
			if (!token) {
				return new Response('Missing token', {status: 400});
			}

			const result = await _verifyToken(token, env, request);
			// 验证成功时追加 Set-Cookie
			if (result.status === 200) {
				const timestamp = String(Date.now());
				const signed = await _signCookie(timestamp, env);
				result.headers.set('Set-Cookie', _setCookieHeader(signed));
			}
			return result;
		} catch (error) {
			return new Response('Invalid request body', {status: 400});
		}
	}

	// 3. 任意请求带 X-Turnstile-Token 则自动验证（从 Header 提取）
	const token = request.headers.get('X-Turnstile-Token');
	if (token) {
		const result = await verifyTurnstile(request, env);
		if (result && result.status === 200) {
			const timestamp = String(Date.now());
			const signed = await _signCookie(timestamp, env);
			result.headers.set('Set-Cookie', _setCookieHeader(signed));
		}
		return result;
	}

	// 4. 人脸页面未验证时重定向到欢迎页
	const path = url.pathname;
	const protectedPaths = ['/login', '/admin'];
	const needProtect = protectedPaths.some(p => path === p || path.startsWith(p + '/'));
	if (needProtect) {
		const verified = await _getVerifiedCookie(request, env);
		if (!verified) {
			return Response.redirect('/', 302);
		}
	}

	// 5. 其他情况放行
	return null;
}

/**
 * 入口拦截验证：从请求 Header 中提取 X-Turnstile-Token 并验证
 *
 * @param {Request} request - 原始请求对象
 * @param {Object} env - Workers 环境变量
 * @returns {Promise<Response|null>} 验证失败返回 403，无需验证返回 null
 */
async function verifyTurnstile(request, env) {
	if (!isTurnstileEnabled(env)) {
		return null;
	}

	const token = request.headers.get('X-Turnstile-Token');
	if (!token || request.method !== 'POST') {
		return null;
	}

	return await _verifyToken(
		token,
		env,
		request,
	);
}

/**
 * 内部：向 Cloudflare 发送 token 验证请求，并返回封装的 Response
 *
 * 封装了请求发送、应答解析、成功/失败/异常处理。
 * 被 verifyTurnstile（Header 提取）和 /turnstile/verify 接口（Body 提取）共同调用。
 *
 * @param {string} token - Turnstile 客户端 token
 * @param {Object} env - Workers 环境变量
 * @param {Request} request - 原始请求对象（用于获取客户端 IP）
 * @returns {Promise<Response>}
 *   - 验证通过 → 200 { success: true }
 *   - 验证失败 → 403 Turnstile 验证失败，token 无效或已过期
 *   - 请求异常 → 502 Turnstile 验证请求异常，请稍后重试
 */
async function _verifyToken(token, env, request) {
	try {
		const verifyResult = await fetch(
			'https://challenges.cloudflare.com/turnstile/v0/siteverify',
			{
				method: 'POST',
				body: new URLSearchParams({
					secret: env.TURNSTILE_SECRET_KEY,
					response: token,
					remoteip: request.headers.get('CF-Connecting-IP') || '',
				}),
			},
		);

		const outcome = await verifyResult.json();

		if (outcome.success) {
			return new Response(
				JSON.stringify({success: true}),
				{
					status: 200,
					headers: {'Content-Type': 'application/json'},
				},
			);
		}

		return new Response('Turnstile 验证失败，token 无效或已过期', {status: 403});
	} catch (error) {
		return new Response('Turnstile 验证请求异常，请稍后重试', {status: 502});
	}
}

export {isTurnstileEnabled, verifyTurnstile, handleTurnstileRequest};