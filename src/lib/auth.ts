import { NextAuthOptions, DefaultSession } from 'next-auth';
import AzureADProvider from 'next-auth/providers/azure-ad';
import CredentialsProvider from 'next-auth/providers/credentials';

declare module 'next-auth' {
  interface Session extends DefaultSession {
    user: {
      id: string;
      role: string;
    } & DefaultSession['user'];
  }

  interface User {
    id: string;
    role?: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    role?: string;
    id?: string;
  }
}

const isProduction = process.env.NODE_ENV === 'production';
const localAuthSecret = (process.env.INFRALITH_DEV_AUTH_SECRET || '').trim();
const secureCookiePrefix = isProduction ? '__Secure-' : '';
const allowedDevEmails = new Set(
  (process.env.INFRALITH_DEV_ALLOWED_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

const azureClientId = (process.env.AZURE_AD_CLIENT_ID || '').trim();
const azureClientSecret = (process.env.AZURE_AD_CLIENT_SECRET || '').trim();
const azureTenantId = (process.env.AZURE_AD_TENANT_ID || '').trim();

function roleFromEmail(email: string): string {
  if (email.startsWith('admin@') || email.includes('.admin@')) return 'Admin';
  if (email.startsWith('supervisor@') || email.includes('.supervisor@')) return 'Supervisor';
  return 'Engineer';
}

const authProviders: NextAuthOptions['providers'] = [];

if (azureClientId && azureClientSecret && azureTenantId) {
  authProviders.push(
    AzureADProvider({
      clientId: azureClientId,
      clientSecret: azureClientSecret,
      tenantId: azureTenantId,
      authorization: {
        params: {
          scope: 'openid profile email User.Read',
        },
      },
      profile(profile) {
        const roles = Array.isArray(profile.roles) ? profile.roles : [];
        let role = 'Guest';

        const adminRole = process.env.AZURE_AD_APP_ROLE_ADMIN || 'Admin';
        const supervisorRole = process.env.AZURE_AD_APP_ROLE_SUPERVISOR || 'Supervisor';
        const engineerRole = process.env.AZURE_AD_APP_ROLE_ENGINEER || 'Engineer';

        const adminId = '0fbd3a6b-4e6d-456c-829b-734796328639';
        const supervisorId = '1df35c95-09d9-4806-95b7-7ead4a233519';
        const engineerId = '5b348725-935a-4e7b-8919-48f06910609b';

        if (roles.includes(adminRole) || roles.includes(adminId)) role = 'Admin';
        else if (roles.includes(supervisorRole) || roles.includes(supervisorId)) role = 'Supervisor';
        else if (roles.includes(engineerRole) || roles.includes(engineerId)) role = 'Engineer';

        const email = (profile.email || profile.preferred_username || '').trim().toLowerCase();
        return {
          id: String(profile.sub || profile.oid || email || `user-${Date.now()}`),
          name: profile.name || email || 'User',
          email,
          image: null,
          role,
        };
      },
    })
  );
}

if (!isProduction) {
  authProviders.push(
    CredentialsProvider({
      name: 'Dummy Login',
      credentials: {
        email: { label: 'Email', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = (credentials?.email || '').trim().toLowerCase();
        const password = String(credentials?.password || '');

        if (!email || !password) return null;
        if (!localAuthSecret || password !== localAuthSecret) return null;
        if (allowedDevEmails.size > 0 && !allowedDevEmails.has(email)) return null;

        return {
          id: `dev-${email.replace(/[^a-z0-9]+/g, '-')}`,
          name: email.split('@')[0].replace(/[^a-zA-Z]/g, ' ').trim() || 'Developer',
          email,
          role: roleFromEmail(email),
        };
      },
    })
  );
}

export const authOptions: NextAuthOptions = {
  providers: authProviders,
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role;
        token.id = user.id;
      }
      if (!token.role) {
        token.role = roleFromEmail(String(token.email || '').toLowerCase());
      }
      if (!token.id) {
        token.id = String(token.sub || token.email || `anon-${Date.now()}`);
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.role = String(token.role || roleFromEmail(String(session.user.email || '').toLowerCase()));
        session.user.id = String(token.id || token.sub || session.user.email || `anon-${Date.now()}`);
      }
      return session;
    },
  },
  pages: {
    signIn: '/',
  },
  secret: process.env.NEXTAUTH_SECRET,
  cookies: {
    sessionToken: {
      name: `${secureCookiePrefix}next-auth.session-token`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: isProduction,
      },
    },
    state: {
      name: `${secureCookiePrefix}next-auth.state`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: isProduction,
        maxAge: 900,
      },
    },
  },
};
