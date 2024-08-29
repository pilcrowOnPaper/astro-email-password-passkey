import { getPasswordReset2FARedirect } from "@lib/server/2fa";
import { validatePasswordResetSessionRequest } from "@lib/server/password-reset";

import type { APIContext } from "astro";

export function GET(context: APIContext): Response {
	const { session, user } = validatePasswordResetSessionRequest(context);
	if (session === null) {
		return context.redirect("/login");
	}

	if (session.twoFactorVerified) {
		return context.redirect("/");
	}
	if (!user.registered2FA) {
		return context.redirect("/password-reset");
	}
	return context.redirect(getPasswordReset2FARedirect(user));
}
