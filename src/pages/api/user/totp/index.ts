import { decodeBase64 } from "@oslojs/encoding";
import { verifyTOTP } from "@oslojs/otp";
import { deleteUserTOTPKey, updateUserTOTPKey } from "@lib/server/totp";
import { ObjectParser } from "@pilcrowjs/object-parser";
import { setSessionAs2FAVerified } from "@lib/server/session";
import { totpUpdateBucket } from "@lib/server/totp";

import type { APIContext } from "astro";

export async function POST(context: APIContext): Promise<Response> {
	if (context.locals.session === null || context.locals.user === null) {
		return new Response(null, {
			status: 401
		});
	}
	if (!context.locals.user.emailVerified) {
		return new Response(null, {
			status: 401
		});
	}
	if (context.locals.user.registered2FA && !context.locals.session.twoFactorVerified) {
		return new Response(null, {
			status: 401
		});
	}
	if (!totpUpdateBucket.check(context.locals.user.id, 1)) {
		return new Response("Too many requests", {
			status: 429
		});
	}
	const data: unknown = await context.request.json();
	const parser = new ObjectParser(data);
	let encodedKey: string, code: string;
	try {
		encodedKey = parser.getString("key");
		code = parser.getString("code");
	} catch {
		return new Response("Invalid or missing fields", {
			status: 400
		});
	}
	if (code === "") {
		return new Response("Please enter your code", {
			status: 401
		});
	}
	if (encodedKey.length !== 28) {
		return new Response("Invalid key", {
			status: 400
		});
	}
	const key = decodeBase64(encodedKey);
	if (key.byteLength !== 20) {
		return new Response("Invalid key", {
			status: 400
		});
	}
	if (!verifyTOTP(key, 30, 6, code)) {
		return new Response("Invalid code", {
			status: 400
		});
	}
	updateUserTOTPKey(context.locals.session.userId, key);
	setSessionAs2FAVerified(context.locals.session.id);
	return new Response(null, { status: 204 });
}

export async function DELETE(context: APIContext): Promise<Response> {
	if (context.locals.session === null || context.locals.user === null) {
		return new Response(null, {
			status: 401
		});
	}
	if (!context.locals.user.emailVerified) {
		return new Response(null, {
			status: 401
		});
	}
	if (context.locals.user.registered2FA && !context.locals.session.twoFactorVerified) {
		return new Response(null, {
			status: 401
		});
	}
	if (!totpUpdateBucket.check(context.locals.user.id, 1)) {
		return new Response("Too many requests", {
			status: 429
		});
	}
	deleteUserTOTPKey(context.locals.user.id);
	return new Response(null, { status: 204 });
}
