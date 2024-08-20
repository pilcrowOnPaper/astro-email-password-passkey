import { encodeBase32 } from "@oslojs/encoding";
import { db } from "./db";
import { hashPassword } from "./password";

export function verifyUsernameInput(username: string): boolean {
	return username.length > 3 && username.length < 32 && username.trim() === username;
}

export async function createUser(email: string, username: string, password: string): Promise<User> {
	const passwordHash = await hashPassword(password);
	const recoveryCode = generateRandomRecoveryCode();
	const createdAt = new Date();
	const row = db.queryOne(
		"INSERT INTO user (email, username, password_hash, created_at, recovery_code) VALUES (?, ?, ?, ?, ?) RETURNING user.id",
		[email, username, passwordHash, Math.floor(createdAt.getTime() / 1000), recoveryCode]
	);
	if (row === null) {
		throw new Error("Unexpected error");
	}
	const user: User = {
		id: row.number(0),
		username,
		email,
		emailVerified: false,
		createdAt,
		registeredTOTP: false,
		registeredPasskey: false,
		registeredSecurityKey: false,
		registered2FA: false
	};
	return user;
}

export function getUser(userId: number): User | null {
	const row = db.queryOne(
		`SELECT user.id, user.email, user.username, user.email_verified, user.created_at, IIF(totp_credential.id IS NOT NULL, 1, 0), IIF(passkey_credential.id IS NOT NULL, 1, 0), IIF(security_key_credential.id IS NOT NULL, 1, 0) FROM user
        LEFT JOIN totp_credential ON user.id = totp_credential.user_id
        LEFT JOIN passkey_credential ON user.id = passkey_credential.user_id
        LEFT JOIN security_key_credential ON user.id = security_key_credential.user_id
        WHERE user.id = ?`,
		[userId]
	);
	if (row === null) {
		return null;
	}
	const user: User = {
		id: row.number(0),
		email: row.string(1),
		username: row.string(2),
		emailVerified: Boolean(row.number(3)),
		createdAt: new Date(row.number(4) * 1000),
		registeredTOTP: Boolean(row.number(5)),
		registeredPasskey: Boolean(row.number(6)),
		registeredSecurityKey: Boolean(row.number(7)),
		registered2FA: false
	};
	if (user.registeredPasskey || user.registeredSecurityKey || user.registeredTOTP) {
		user.registered2FA = true;
	}
	return user;
}

export function getUserPasswordHash(userId: number): string {
	const row = db.queryOne("SELECT password_hash FROM user WHERE id = ?", [userId]);
	if (row === null) {
		throw new Error("Invalid user ID");
	}
	return row.string(0);
}

export function getUserRecoverCode(userId: number): string {
	const row = db.queryOne("SELECT recovery_code FROM user WHERE id = ?", [userId]);
	if (row === null) {
		throw new Error("Invalid user ID");
	}
	return row.string(0);
}

export function getUserTOTPKey(userId: number): Uint8Array | null {
	const row = db.queryOne("SELECT totp_credential.key FROM totp_credential WHERE user_id = ?", [userId]);
	if (row === null) {
		throw new Error("Invalid user ID");
	}
	return row.bytesNullable(0);
}

export function getUserFromEmail(email: string): User | null {
	const row = db.queryOne(
		`SELECT user.id, user.email, user.username, user.email_verified, user.created_at, IIF(totp_credential.id IS NOT NULL, 1, 0), IIF(passkey_credential.id IS NOT NULL, 1, 0), IIF(security_key_credential.id IS NOT NULL, 1, 0) FROM user
        LEFT JOIN totp_credential ON user.id = totp_credential.user_id
        LEFT JOIN passkey_credential ON user.id = passkey_credential.user_id
        LEFT JOIN security_key_credential ON user.id = security_key_credential.user_id
        WHERE user.email = ?`,
		[email]
	);
	if (row === null) {
		return null;
	}
	const user: User = {
		id: row.number(0),
		email: row.string(1),
		username: row.string(2),
		emailVerified: Boolean(row.number(3)),
		createdAt: new Date(row.number(4) * 1000),
		registeredTOTP: Boolean(row.number(5)),
		registeredPasskey: Boolean(row.number(6)),
		registeredSecurityKey: Boolean(row.number(7)),
		registered2FA: false
	};
	if (user.registeredPasskey || user.registeredSecurityKey || user.registeredTOTP) {
		user.registered2FA = true;
	}
	return user;
}

export function verifyUserRecoveryCode(userId: number, recoveryCode: string): boolean {
	const newRecoveryCode = generateRandomRecoveryCode();
	try {
		db.execute("BEGIN TRANSACTION", []);
		const result = db.execute("UPDATE user SET recovery_code = ? WHERE id = ? AND recovery_code = ?", [
			newRecoveryCode,
			userId,
			recoveryCode
		]);
		if (result.changes < 1) {
			db.execute("COMMIT", []);
			return false;
		}
		db.execute("DELETE FROM totp_credential WHERE user_id = ?", [userId]);
		db.execute("DELETE FROM passkey_credential WHERE user_id = ?", [userId]);
		db.execute("DELETE FROM security_key_credential WHERE user_id = ?", [userId]);
		db.execute("UPDATE session SET two_factor_verified = 0 WHERE user_id = ?", [userId]);
		db.execute("COMMIT", []);
		return true;
	} catch (e) {
		if (db.inTransaction()) {
			db.execute("ROLLBACK", []);
		}
		throw e;
	}
}

export function resetUserRecoveryCode(userId: number): string {
	const recoveryCode = generateRandomRecoveryCode();
	db.execute("UPDATE user SET recovery_code = ? WHERE id = ?", [recoveryCode, userId]);
	return recoveryCode;
}

export function verifyUserEmail(userId: number, email: string): void {
	db.execute("UPDATE user SET email_verified = 1, email = ? WHERE id = ?", [email, userId]);
}

export async function updateUserPasswordWithEmailVerification(
	userId: number,
	email: string,
	password: string
): Promise<void> {
	const passwordHash = await hashPassword(password);
	try {
		db.execute("BEGIN TRANSACTION", []);
		const result = db.execute("UPDATE user SET password_hash = ? WHERE id = ? AND email = ?", [
			passwordHash,
			userId,
			email
		]);
		if (result.changes < 1) {
			db.execute("COMMIT", []);
			throw new Error("Invalid user ID");
		}
		db.execute("DELETE FROM session WHERE user_id = ?", [userId]);
		db.execute("COMMIT", []);
	} catch (e) {
		if (db.inTransaction()) {
			db.execute("ROLLBACK", []);
		}
		throw e;
	}
}

export async function updateUserPassword(sessionId: string, userId: number, password: string): Promise<void> {
	const passwordHash = await hashPassword(password);
	try {
		db.execute("BEGIN TRANSACTION", []);
		db.execute("UPDATE user SET password_hash = ? WHERE id = ?", [passwordHash, userId]);
		db.execute("DELETE FROM session WHERE id != ? AND user_id = ?", [sessionId, userId]);
		db.execute("COMMIT", []);
	} catch (e) {
		if (db.inTransaction()) {
			db.execute("ROLLBACK", []);
		}
		throw e;
	}
}

export function updateUserTOTPKey(sessionId: string, userId: number, key: Uint8Array): void {
	try {
		db.execute("BEGIN TRANSACTION", []);
		db.execute("DELETE FROM totp_credential WHERE user_id = ?", [userId]);
		db.execute("INSERT INTO totp_credential (user_id, key) VALUES (?, ?)", [userId, key]);
		db.execute("DELETE FROM session WHERE id != ? AND user_id = ?", [sessionId, userId]);
		db.execute("UPDATE session SET two_factor_verified = 1 WHERE id = ?", [sessionId]);
		db.execute("COMMIT", []);
	} catch (e) {
		if (db.inTransaction()) {
			db.execute("ROLLBACK", []);
		}
		throw e;
	}
}

function generateRandomRecoveryCode(): string {
	const recoveryCodeBytes = new Uint8Array(10);
	crypto.getRandomValues(recoveryCodeBytes);
	const recoveryCode = encodeBase32(recoveryCodeBytes);
	return recoveryCode;
}

export interface User {
	id: number;
	email: string;
	username: string;
	emailVerified: boolean;
	createdAt: Date;
	registeredTOTP: boolean;
	registeredSecurityKey: boolean;
	registeredPasskey: boolean;
	registered2FA: boolean;
}
