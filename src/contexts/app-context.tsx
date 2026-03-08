
'use client';
import { authService, SignUpData, ChatSession, UserProfileData, infralithService } from '@/lib/services';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useSession, signIn, signOut } from 'next-auth/react';
import { runInfralithWorkflow } from '@/ai/flows/infralith/workflow-orchestrator';
import { PIPELINE_STAGE_COUNT, PIPELINE_STAGE_ERROR } from '@/ai/flows/infralith/pipeline';
import { auditLog } from '@/lib/audit-log';
import { runLocalStorageMigrations } from '@/lib/local-storage-migrations';

type User = UserProfileData & { role?: string };

type Theme = 'light' | 'dark' | 'system';
type LoginView = 'login' | 'signup' | 'completeGoogleProfile';

export type SignupFormState = {
  firstName?: string;
  lastName?: string;
  email?: string;
  mobile?: string;
  age?: string;
  gender?: string;
  country?: string;
  language?: string;
  fieldOfInterest?: string;
  avatar?: string | null;
  currentStep?: number;
  password?: string;
  confirmPassword?: string;
};

interface AppContextType {
  activeRoute: string;
  authed: boolean;
  user: User | null;
  showLogin: boolean;
  isMobileMenuOpen: boolean;
  theme: Theme;
  loginView: LoginView;
  signupFormState: SignupFormState;
  chatHistory: ChatSession[];
  isLoadingAuth: boolean;
  isAuthLoading: boolean;
  isProfileChecked: boolean;
  setActiveRoute: Dispatch<SetStateAction<string>>;
  setShowLogin: Dispatch<SetStateAction<boolean>>;
  setIsMobileMenuOpen: Dispatch<SetStateAction<boolean>>;
  setLoginView: Dispatch<SetStateAction<LoginView>>;
  setSignupFormState: Dispatch<SetStateAction<SignupFormState>>;
  clearSignupForm: () => void;
  handleNavigate: (key: string) => void;
  handleLogin: (email: string, pass: string) => Promise<void>;
  handleSignUp: (data: SignUpData) => Promise<void>;
  handleLogout: () => void;
  toggleTheme: () => void;
  handleDeleteAccount: () => Promise<void>;
  handleProfileUpdate: (data: Partial<User>) => Promise<void>;
  handleSelectRole: (role: string) => void;
  showRoleSelection: boolean;
  setShowRoleSelection: Dispatch<SetStateAction<boolean>>;
  infralithResult: any | null;
  pipelineStage: number;
  runInfralithEvaluation: (input: File) => Promise<void>;
}

const AppContext = createContext<AppContextType | null>(null);

const initialSignupFormState: SignupFormState = {
  firstName: '',
  lastName: '',
  email: '',
  password: '',
  confirmPassword: '',
  mobile: '',
  age: '',
  gender: '',
  country: '',
  language: '',
  fieldOfInterest: '',
  avatar: null,
  currentStep: 1,
};

export function AppProvider({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();

  const [activeRoute, setActiveRoute] = useState('home');
  const [user, setUser] = useState<User | null>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isProfileChecked, setIsProfileChecked] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [showRoleSelection, setShowRoleSelection] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>('dark');
  const [loginView, setLoginView] = useState<LoginView>('login');
  const [signupFormState, setSignupFormState] = useState<SignupFormState>(initialSignupFormState);
  const [chatHistory, setChatHistory] = useState<ChatSession[]>([]);
  const { toast } = useToast();
  const [infralithResult, setInfralithResult] = useState<any | null>(null);
  const [pipelineStage, setPipelineStage] = useState(0);
  const [directoryRegisteredUserId, setDirectoryRegisteredUserId] = useState<string | null>(null);

  const clearSignupForm = () => setSignupFormState(initialSignupFormState);

  const refreshInfralithData = useCallback(async () => {
    if (user?.uid) {
      try {
        const results = await infralithService.getEvaluations(user.uid);
        if (results.length > 0) {
          setInfralithResult(results[0]);
        }
      } catch (error) {
        console.error("Failed to refresh Infralith data:", error);
      }
    }
  }, [user?.uid]);

  // Sync NextAuth Session and User State
  useEffect(() => {
    if (status === 'loading') {
      setIsLoadingAuth(true);
      return;
    }

    if (status === 'authenticated' && session?.user) {
      setShowLogin(false);

      const sessionUser = session.user as any;
      const sessionRole = sessionUser.role || 'Guest';

      // Only update if user is not set OR if user ID has changed OR if it's a first-time guest role sync
      if (!user || user.uid !== sessionUser.id || (user.role === 'Guest' && sessionRole !== 'Guest')) {
        setUser({
          uid: sessionUser.id || '',
          name: sessionUser.name || '',
          email: sessionUser.email || '',
          role: sessionRole,
          profileCompleted: true
        } as any);

        if (sessionRole === 'Guest') {
          setShowRoleSelection(false); // No popup — GuestDashboard handles role selection inline
          setActiveRoute('home');      // Navigate to home which renders GuestDashboard
        } else {
          setShowRoleSelection(false);
          setActiveRoute('home');
        }
      }
    } else if (status === 'unauthenticated' && user !== null) {
      setUser(null);
      setChatHistory([]);
      setInfralithResult(null);
      setShowRoleSelection(false);
    }

    setIsLoadingAuth(false);
    setIsProfileChecked(true);
  }, [session, status]); // REMOVED user from dependencies to prevent infinite loop, as we use it inside. Using status and session is enough.

  useEffect(() => {
    if (user?.uid) {
      refreshInfralithData();
    }
  }, [user?.uid, refreshInfralithData]);

  useEffect(() => {
    if (!user?.uid) {
      setDirectoryRegisteredUserId(null);
      return;
    }
    if (directoryRegisteredUserId === user.uid) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const maxAttempts = 4;
    const baseRetryDelayMs = 2_000;

    const registerCurrentUser = async (attempt = 1) => {
      try {
        const res = await fetch('/api/infralith/users', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'register_current' }),
        });
        if (res.ok && !cancelled) {
          setDirectoryRegisteredUserId(user.uid);
          return;
        }
        if (!res.ok) {
          console.warn('Failed to register user in directory', { status: res.status, attempt });
        }
      } catch (error) {
        console.warn('Failed to register user in directory', error);
      }

      if (cancelled || attempt >= maxAttempts) return;
      const nextDelay = baseRetryDelayMs * attempt;
      retryTimer = setTimeout(() => {
        void registerCurrentUser(attempt + 1);
      }, nextDelay);
    };

    void registerCurrentUser();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [user?.uid, directoryRegisteredUserId]);

  useEffect(() => {
    if (!isLoadingAuth && user && showLogin) {
      if (loginView !== 'completeGoogleProfile') {
        setShowLogin(false);
        toast({ title: 'Login Successful!' });
      }
      if (isAuthLoading) {
        setIsAuthLoading(false);
      }
    }
  }, [user, isLoadingAuth, showLogin, isAuthLoading, loginView, toast]);

  useEffect(() => {
    runLocalStorageMigrations();

    const onHash = () => {
      const key = window.location.hash.replace('#', '');
      if (key) setActiveRoute(key);
    };
    window.addEventListener('hashchange', onHash);
    onHash();
    const storedTheme = localStorage.getItem('theme') as Theme | null;
    if (storedTheme) {
      setTheme(storedTheme);
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      setTheme(prefersDark ? 'dark' : 'light');
    }
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(p => (p === 'dark' ? 'light' : 'dark'));
  const handleNavigate = (key: string) => {
    setActiveRoute(key);
    window.location.hash = key;
    setIsMobileMenuOpen(false);
  };
  const handleSelectRole = (role: string) => {
    if (user) {
      setUser({ ...user, role });
      setShowRoleSelection(false);
      handleNavigate('home');
      toast({ title: `Role Set to ${role}`, description: "You now have access to your dashboard." });
    }
  };
  const handleLogin = async (email: string, pass: string) => {
    setIsAuthLoading(true);
    try {
      const result = await signIn('credentials', {
        redirect: false,
        email,
        password: pass,
      });
      if (result?.error) throw new Error(result.error);
      setShowLogin(false);
      toast({ title: 'Welcome to Infralith' });
    } catch (error: any) {
      setIsAuthLoading(false);
      toast({ variant: 'destructive', title: 'Login Failed', description: 'Please check your email and password.' });
      throw error;
    }
  };
  const handleLogout = async () => {
    if (user) auditLog.record('USER_LOGOUT', { uid: user.uid, name: user.name, role: user.role, email: user.email });
    signOut({ callbackUrl: '/' });
    setUser(null);
    handleNavigate('home');
    toast({ title: 'Logged Out' });
  };

  const handleSignUp = async (data: SignUpData) => {
    setIsAuthLoading(true);
    try {
      await authService.signUp(data);
      const result = await signIn('credentials', {
        redirect: false,
        email: data.email,
        password: data.password || "",
      });
      if (result?.error) throw new Error(result.error);

      clearSignupForm();
      setShowLogin(false);
      toast({ title: 'Signup Successful!', description: 'Welcome aboard.' });
    } catch (error: any) {
      setIsAuthLoading(false);
      toast({
        variant: 'destructive',
        title: 'Sign-up Failed',
        description: 'An error occurred during sign-up.'
      });
      throw error;
    }
  };

  const handleDeleteAccount = async () => {
    if (!user) return;
    try {
      auditLog.record('USER_DELETED', { uid: user.uid, name: user.name, role: user.role, email: user.email }, { reason: 'Self-initiated deletion' });
      await authService.deleteAccount(user.uid);
      toast({ title: 'Account Deleted', description: 'Your account has been permanently deleted.' });
    } catch (error) {
      console.error('Failed to delete account:', error);
      toast({ variant: 'destructive', title: 'Deletion Failed', description: 'Could not delete your account. Please try again.' });
      throw error;
    }
  };

  const handleProfileUpdate = async (data: Partial<User>) => {
    if (!user) return;
    try {
      const profileData: Partial<UserProfileData> = {
        ...data,
        email: user.email || undefined,
      };
      await authService.updateProfile(user.uid, profileData);
      toast({ title: 'Profile Saved Successfully!' });
      if (data.profileCompleted) {
        clearSignupForm();
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Update Failed',
        description: 'Could not save your profile.'
      });
      throw error;
    }
  };

  const runInfralithEvaluation = async (input: File) => {
    setIsAuthLoading(true);
    setPipelineStage(0);

    // Audit: record the upload initiation
    if (user) {
      auditLog.record('BLUEPRINT_UPLOADED',
        { uid: user.uid, name: user.name, role: user.role, email: user.email },
        { fileName: input.name, fileSize: input.size }
      );
    }

    // Simulate agent progression while server action runs
    const progInterval = setInterval(() => {
      setPipelineStage(prev => (prev < PIPELINE_STAGE_COUNT - 1 ? prev + 1 : prev));
    }, 2000);

    try {
      const formData = new FormData();
      formData.append('file', input);

      const result = await runInfralithWorkflow(formData);
      console.log("DEBUG: Infralith Workflow Result on Client:", result);

      clearInterval(progInterval);
      setPipelineStage(PIPELINE_STAGE_COUNT);
      setInfralithResult(result);

      if (user?.uid) {
        await infralithService.saveEvaluation(user.uid, result as any);
      }

      // Audit: record completed analysis with reproducibility metadata
      if (user) {
        auditLog.record('ANALYSIS_COMPLETE',
          { uid: user.uid, name: user.name, role: user.role, email: user.email },
          {
            reportId: result.id,
            runId: result.modelVersion?.runId,
            modelVersion: result.modelVersion?.orchestratorVersion,
            llmModel: result.modelVersion?.llmModel,
            parameterHash: result.modelVersion?.parameterHash,
            latencyMs: result.pipelineLatencyMs,
            complianceScore: result.complianceScore,
            riskLevel: result.riskReport?.level,
            approvalStatus: 'pending',
          }
        );
      }

      toast({
        title: "AI Analysis Complete",
        description: "Specialized agents have successfully processed the blueprint.",
      });
      handleNavigate('report');
    } catch (error) {
      clearInterval(progInterval);
      setPipelineStage(PIPELINE_STAGE_ERROR);
      console.error("Infralith workflow failed:", error);

      if (user) {
        auditLog.record('ANALYSIS_COMPLETE',
          { uid: user.uid, name: user.name, role: user.role, email: user.email },
          { error: String(error), status: 'FAILED' }
        );
      }

      toast({
        variant: "destructive",
        title: "Analysis Failed",
        description: "The AI multi-agent pipeline encountered an error."
      });
      throw error;
    } finally {
      setIsAuthLoading(false);
    }
  };


  const value: AppContextType = {
    activeRoute,
    authed: !!user,
    user,
    showLogin,
    isMobileMenuOpen,
    theme,
    loginView,
    signupFormState,
    chatHistory,
    isLoadingAuth,
    isAuthLoading,
    isProfileChecked,
    setActiveRoute,
    setShowLogin,
    showRoleSelection,
    setShowRoleSelection,
    setIsMobileMenuOpen,
    setLoginView,
    setSignupFormState,
    clearSignupForm,
    handleNavigate,
    handleLogin,
    handleSignUp,
    handleSelectRole,
    handleLogout,
    toggleTheme,
    handleProfileUpdate,
    handleDeleteAccount,
    infralithResult,
    pipelineStage,
    runInfralithEvaluation,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
}
