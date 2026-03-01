import { NextAuthOptions, DefaultSession } from "next-auth";
import AzureADProvider from "next-auth/providers/azure-ad";
import CredentialsProvider from "next-auth/providers/credentials";

// Define custom session types
declare module "next-auth" {
    interface Session extends DefaultSession {
        user: {
            id: string;
            role: string;
        } & DefaultSession["user"];
    }

    interface User {
        role?: string;
    }
}

declare module "next-auth/jwt" {
    interface JWT {
        role?: string;
        id?: string;
    }
}

const isProduction = process.env.NODE_ENV === "production";
const localAuthSecret = (process.env.INFRALITH_DEV_AUTH_SECRET || "").trim();
const secureCookiePrefix = isProduction ? "__Secure-" : "";
const allowedDevEmails = new Set(
    (process.env.INFRALITH_DEV_ALLOWED_EMAILS || "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
);

function roleFromEmail(email: string): string {
    if (email.startsWith("admin@") || email.includes(".admin@")) return "Admin";
    if (email.startsWith("supervisor@") || email.includes(".supervisor@")) return "Supervisor";
    return "Engineer";
}

export const authOptions: NextAuthOptions = {
    providers: [
        AzureADProvider({
            clientId: (process.env.AZURE_AD_CLIENT_ID || "").trim(),
            clientSecret: (process.env.AZURE_AD_CLIENT_SECRET || "").trim(),
            tenantId: (process.env.AZURE_AD_TENANT_ID || "").trim(),
            authorization: {
                params: {
                    scope: "openid profile email User.Read",
                },
            },
            profile(profile) {
                // Debug log to confirm identity is reaching this point (visible in Log Stream)
                console.log("[Auth] Profile mapping for:", profile.email || profile.preferred_username);

                const roles = Array.isArray(profile.roles) ? profile.roles : [];
                let role = "Guest";

                // Map Azure AD roles to application roles using env variables or direct matches
                const adminRole = process.env.AZURE_AD_APP_ROLE_ADMIN || "Admin";
                const supervisorRole = process.env.AZURE_AD_APP_ROLE_SUPERVISOR || "Supervisor";
                const engineerRole = process.env.AZURE_AD_APP_ROLE_ENGINEER || "Engineer";

                // Azure Role IDs from portal screenshot for extra safety
                const adminId = "0fbd3a6b-4e6d-456c-829b-734796328639";
                const supervisorId = "1df35c95-09d9-4806-95b7-7ead4a233519";
                const engineerId = "5b348725-935a-4e7b-8919-48f06910609b";

                if (roles.includes(adminRole) || roles.includes(adminId)) role = "Admin";
                else if (roles.includes(supervisorRole) || roles.includes(supervisorId)) role = "Supervisor";
                else if (roles.includes(engineerRole) || roles.includes(engineerId)) role = "Engineer";

                return {
                    id: profile.sub,
                    name: profile.name,
                    email: profile.email || profile.preferred_username,
                    image: null,
                    role: role,
                };
            },
        }),
        CredentialsProvider({
            name: "Dummy Login",
            credentials: {
                email: { label: "Email", type: "text" },
                password: { label: "Password", type: "password" },
            },
            async authorize(credentials) {
                if (isProduction) {
                    return null;
                }

                const email = (credentials?.email || "").trim().toLowerCase();
                const password = String(credentials?.password || "");

                if (!email || !password) return null;
                if (!localAuthSecret || password !== localAuthSecret) return null;
                if (allowedDevEmails.size > 0 && !allowedDevEmails.has(email)) return null;

                return {
                    id: `dev-${email.replace(/[^a-z0-9]+/g, "-")}`,
                    name: email.split("@")[0].replace(/[^a-zA-Z]/g, " ").trim() || "Developer",
                    email,
                    role: roleFromEmail(email),
                };
            },
        })
    ],
    callbacks: {
        async jwt({ token, user }) {
            if (user) {
                token.role = user.role;
                token.id = user.id;
            }
            return token;
        },
        async session({ session, token }) {
            if (session.user) {
                (session.user as any).role = token.role;
                (session.user as any).id = token.id;
            }
            return session;
        },
    },

    pages: {
        signIn: "/", // Redirect to home where the login modal will appear
    },
    secret: process.env.NEXTAUTH_SECRET,
    cookies: {
        sessionToken: {
            name: `${secureCookiePrefix}next-auth.session-token`,
            options: {
                httpOnly: true,
                sameSite: "lax",
                path: "/",
                secure: isProduction,
            },
        },
        state: {
            name: `${secureCookiePrefix}next-auth.state`,
            options: {
                httpOnly: true,
                sameSite: "lax",
                path: "/",
                secure: isProduction,
                maxAge: 900,
            },
        }
    }
};
