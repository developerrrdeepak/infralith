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
    }
}

export const authOptions: NextAuthOptions = {
    providers: [
        AzureADProvider({
            clientId: process.env.AZURE_AD_CLIENT_ID || "dummy",
            clientSecret: process.env.AZURE_AD_CLIENT_SECRET || "dummy",
            tenantId: process.env.AZURE_AD_TENANT_ID || "dummy",
            authorization: {
                params: {
                    scope: "openid profile email User.Read",
                },
            },
            profile(profile) {
                const roles = profile.roles || [];
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
                    email: profile.email,
                    image: null,
                    role: role,
                };
            },
        }),
        CredentialsProvider({
            name: "Dummy Login",
            credentials: {
                email: { label: "Email", type: "text" },
                role: { label: "Role", type: "text" }
            },
            async authorize(credentials) {
                if (credentials?.email) {
                    return {
                        id: "dummy-user-id-" + Math.random().toString(36).substr(2, 9),
                        name: credentials.email.split('@')[0].replace(/[^a-zA-Z]/g, ' '),
                        email: credentials.email,
                        role: credentials.role || "Admin",
                    };
                }
                return null;
            }
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
    trustHost: true,
};
