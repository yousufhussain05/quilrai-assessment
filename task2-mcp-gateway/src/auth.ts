import { SignJWT, jwtVerify } from "jose";

export type Role = "admin" | "viewer";
export type User = { name: string; role: Role };

export async function verifyToken(header: string | undefined, secret: Uint8Array): Promise<User | null> {
  const token = header?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"], requiredClaims: ["exp"] });
    if (payload.role !== "admin" && payload.role !== "viewer") return null;
    return { name: String(payload.sub), role: payload.role };
  } catch {
    return null;
  }
}

export function makeToken(secret: Uint8Array, name: string, role: Role): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(name)
    .setExpirationTime("1h")
    .sign(secret);
}
