
'use client';
import { authService, resumeService, SignUpData, chatHistoryService, ChatSession, Message, UserProfileData, evaluationService, infralithService } from '@/lib/services';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useSession, signIn, signOut } from 'next-auth/react';
import { runInfralithWorkflow } from '@/ai/flows/infralith/workflow-orchestrator';
import { PIPELINE_STAGE_COUNT, PIPELINE_STAGE_ERROR } from '@/ai/flows/infralith/pipeline';
import { auditLog } from '@/lib/audit-log';

export interface EvaluationContext {
  type: 'Mock Interview' | 'Resume Ranking' | 'Resume Roast' | 'Skill Assessment';
  inputs: Record<string, any>;
  result: any;
  resumeText?: string;
}

type User = UserProfileData & { role?: string };

type UserEvaluations = {
  skillAssessments: any[];
  resumeReviews: any[];
  mockInterviews: any[];
};

export interface ResumeRankerState {
  uploadedFile: File | null;
  pdfBase64: string;
  pdfPreviewUrl: string;
  jobRole: string;
  field: string;
  rankingResult: any | null;
  roastResult: any | null;
}
export interface MockInterviewState {
  uploadedFile: File | null;
  pdfPreviewUrl: string;
  jobRole: string;
  field: string;
  difficulty: 'easy' | 'intermediate' | 'hard' | '';
  candidateName: string;
  resumeText: string;
  resumeAnalysis: any | null;
  evaluation: any | null;
}
export interface SkillAssessmentState {
  answers: { [key: string]: any };
  analysis: any | null;
  selectedRole: string | null;
  roadmap: any | null;
  isFinished: boolean;
  currentQuestionIndex: number;
}

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
  resumeText: string;
  showLogin: boolean;
  showProfileCompletion: boolean;
  isMobileMenuOpen: boolean;
  isInterviewActive: boolean;
  theme: Theme;
  loginView: LoginView;
  signupFormState: SignupFormState;
  chatHistory: ChatSession[];
  isLoadingAuth: boolean;
  isAuthLoading: boolean;
  isProfileChecked: boolean;
  evaluations: UserEvaluations;
  resumeRankerState: ResumeRankerState;
  setResumeRankerState: (newState: Partial<ResumeRankerState>) => void;
  mockInterviewState: MockInterviewState;
  setMockInterviewState: (newState: Partial<MockInterviewState>) => void;
  skillAssessmentState: SkillAssessmentState;
  setSkillAssessmentState: (newState: Partial<SkillAssessmentState>) => void;
  handleClearAssessmentState: () => void;
  handleClearResumeRankerState: () => void;
  handleClearMockInterviewState: () => void;
  setActiveRoute: Dispatch<SetStateAction<string>>;
  setResumeText: (text: string) => void;
  setShowLogin: Dispatch<SetStateAction<boolean>>;
  setIsMobileMenuOpen: Dispatch<SetStateAction<boolean>>;
  setIsInterviewActive: Dispatch<SetStateAction<boolean>>;
  setLoginView: Dispatch<SetStateAction<LoginView>>;
  setSignupFormState: Dispatch<SetStateAction<SignupFormState>>;
  clearSignupForm: () => void;
  handleNavigate: (key: string) => void;
  handleLogin: (email: string, pass: string) => Promise<void>;
  handleSignUp: (data: SignUpData) => Promise<void>;
  handleSignInOrSignUpWithGoogle: () => Promise<void>;
  handleLoginWithGoogle: () => Promise<void>;
  handleLogout: () => void;
  handleCancelSignUp: () => Promise<void>;
  toggleTheme: () => void;
  handleDeleteAccount: () => Promise<void>;
  handleProfileUpdate: (data: Partial<User>) => Promise<void>;
  handleSelectRole: (role: string) => void;
  showRoleSelection: boolean;
  setShowRoleSelection: Dispatch<SetStateAction<boolean>>;
  saveCurrentChat: (messages: Message[], currentSessionId: string | null) => Promise<string | null>;
  startChatWithEvaluationContext: (ctx: EvaluationContext) => void;
  refreshEvaluations: () => Promise<void>;
  generateUserProfileJsonForChat: () => string | null;
  infralithResult: any | null;
  pipelineStage: number;
  runInfralithEvaluation: (input: File) => Promise<void>;
}

const AppContext = createContext<AppContextType | null>(null);

const initialResumeRankerState: ResumeRankerState = {
  uploadedFile: null,
  pdfBase64: '',
  pdfPreviewUrl: '',
  jobRole: '',
  field: '',
  rankingResult: null,
  roastResult: null,
};

const initialMockInterviewState: MockInterviewState = {
  uploadedFile: null,
  pdfPreviewUrl: '',
  jobRole: '',
  field: '',
  difficulty: '',
  candidateName: '',
  resumeText: '',
  resumeAnalysis: null,
  evaluation: null,
};

const initialSkillAssessmentState: SkillAssessmentState = {
  answers: {},
  analysis: null,
  selectedRole: null,
  roadmap: null,
  isFinished: false,
  currentQuestionIndex: 0,
};

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
  const [resumeTextState, setResumeTextState] = useState('');
  const [showLogin, setShowLogin] = useState(false);
  const [showRoleSelection, setShowRoleSelection] = useState(false);
  const [showProfileCompletion, setShowProfileCompletion] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isInterviewActive, setIsInterviewActive] = useState(false);
  const [theme, setTheme] = useState<Theme>('dark');
  const [loginView, setLoginView] = useState<LoginView>('login');
  const [signupFormState, setSignupFormState] = useState<SignupFormState>(initialSignupFormState);
  const [chatHistory, setChatHistory] = useState<ChatSession[]>([]);
  const [evaluations, setEvaluations] = useState<UserEvaluations>({
    skillAssessments: [],
    resumeReviews: [],
    mockInterviews: [],
  });
  const { toast } = useToast();
  const [resumeRankerState, setResumeRankerStateInternal] = useState<ResumeRankerState>(initialResumeRankerState);
  const [mockInterviewState, setMockInterviewStateInternal] = useState<MockInterviewState>(initialMockInterviewState);
  const [infralithResult, setInfralithResult] = useState<any | null>(null);
  const [pipelineStage, setPipelineStage] = useState(0);

  const [skillAssessmentState, setSkillAssessmentStateInternal] = useState<SkillAssessmentState>(() => {
    if (typeof window === 'undefined') {
      return initialSkillAssessmentState;
    }
    try {
      const savedState = sessionStorage.getItem('skillAssessmentState');
      if (savedState) {
        return JSON.parse(savedState);
      }
      return initialSkillAssessmentState;
    } catch (error) {
      console.error('Failed to parse skill assessment state from session storage', error);
      return initialSkillAssessmentState;
    }
  });

  const clearSignupForm = () => setSignupFormState(initialSignupFormState);

  useEffect(() => {
    try {
      sessionStorage.setItem('skillAssessmentState', JSON.stringify(skillAssessmentState));
    } catch (error) {
      console.error('Failed to save skill assessment state to session storage', error);
    }
  }, [skillAssessmentState]);

  const setResumeRankerState = (newState: Partial<ResumeRankerState>) =>
    setResumeRankerStateInternal(p => ({ ...p, ...newState }));
  const setMockInterviewState = (newState: Partial<MockInterviewState>) =>
    setMockInterviewStateInternal(p => ({ ...p, ...newState }));
  const setSkillAssessmentState = (newState: Partial<SkillAssessmentState>) =>
    setSkillAssessmentStateInternal(p => ({ ...p, ...newState }));

  const handleClearAssessmentState = () => setSkillAssessmentStateInternal(initialSkillAssessmentState);
  const handleClearResumeRankerState = () => setResumeRankerStateInternal(initialResumeRankerState);
  const handleClearMockInterviewState = () => {
    setMockInterviewStateInternal(prev => ({ ...initialMockInterviewState, candidateName: prev.candidateName }));
    setIsInterviewActive(false);
  };

  useEffect(() => {
    const url = resumeRankerState.pdfPreviewUrl;
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [resumeRankerState.pdfPreviewUrl]);
  useEffect(() => {
    const url = mockInterviewState.pdfPreviewUrl;
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [mockInterviewState.pdfPreviewUrl]);

  const refreshEvaluations = useCallback(async () => {
    if (user?.uid) {
      try {
        const userEvals = await evaluationService.getEvaluations(user.uid);
        setEvaluations(userEvals);
      } catch (error) {
        console.error("Failed to refresh evaluations:", error);
      }
    }
  }, [user?.uid]);

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
      setEvaluations({ skillAssessments: [], resumeReviews: [], mockInterviews: [] });
      setInfralithResult(null);
      setShowProfileCompletion(false);
      setShowRoleSelection(false);
    }

    setIsLoadingAuth(false);
    setIsProfileChecked(true);
  }, [session, status]); // REMOVED user from dependencies to prevent infinite loop, as we use it inside. Using status and session is enough.

  useEffect(() => {
    if (user?.uid) {
      refreshEvaluations();
      refreshInfralithData();
    }
  }, [user?.uid, refreshEvaluations, refreshInfralithData]);

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
    const onHash = () => {
      const key = window.location.hash.replace('#', '');
      if (key) setActiveRoute(key);
    };
    window.addEventListener('hashchange', onHash);
    onHash();
    setResumeTextState(resumeService.getText());
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

  const handleCancelSignUp = async () => {
    await authService.cancelSignUpAndDeleteAuthUser();
    handleNavigate('home');
    toast({ title: 'Sign-up Canceled' });
  };

  const setResumeText = (text: string) => {
    setResumeTextState(text);
    resumeService.saveText(text);
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

  const handleSignInOrSignUpWithGoogle = async () => {
    signIn('azure-ad', { callbackUrl: '/' });
  };

  const handleLoginWithGoogle = async () => {
    signIn('azure-ad', { callbackUrl: '/' });
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

  const saveCurrentChat = async (messages: Message[], currentSessionId: string | null) => {
    if (!user) return null;
    const { sessionId } = await chatHistoryService.saveChatSession(user.uid, messages, currentSessionId);
    return sessionId || null;
  };

  const generateUserProfileJsonForChat = useCallback(() => {
    if (!user) return null;
    const profile: Record<string, any> = {
      name: user.name,
      email: user.email,
      age: user.age,
      gender: user.gender,
      country: user.country,
      fieldOfInterest: user.fieldOfInterest,
      skills: user.skills,
      experience: user.experience,
      education: {
        college: user.college,
        degree: user.degree,
        gradYear: user.gradYear,
      },
      resumeSummary: resumeTextState,
    };
    return JSON.stringify(Object.fromEntries(Object.entries(profile).filter(([, v]) => v != null && v !== '')));
  }, [user, resumeTextState]);

  const startChatWithEvaluationContext = useCallback((ctx: EvaluationContext) => {
    if (!ctx || !ctx.type || !ctx.result) {
      console.error("Invalid evaluation context provided.");
      return;
    }

    try {
      const serializableContext = JSON.stringify(ctx);
      sessionStorage.setItem('newChatWithContext', serializableContext);
      sessionStorage.removeItem('chatBotWidget_activeSessionId');
      sessionStorage.removeItem('chatBotWidget_input');
      handleNavigate('chat');
    } catch (error) {
      console.error("Failed to serialize evaluation context:", error);
    }
  }, [handleNavigate]);

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
    } finally {
      setIsAuthLoading(false);
    }
  };


  const value: AppContextType = {
    activeRoute,
    authed: !!user,
    user,
    resumeText: resumeTextState,
    showLogin,
    showProfileCompletion,
    isMobileMenuOpen,
    isInterviewActive,
    theme,
    loginView,
    signupFormState,
    chatHistory,
    isLoadingAuth,
    isAuthLoading,
    isProfileChecked,
    evaluations,
    resumeRankerState,
    setResumeRankerState,
    mockInterviewState,
    setMockInterviewState,
    skillAssessmentState,
    setSkillAssessmentState,
    handleClearAssessmentState,
    handleClearResumeRankerState,
    handleClearMockInterviewState,
    setActiveRoute,
    setResumeText,
    setShowLogin,
    showRoleSelection,
    setShowRoleSelection,
    setIsMobileMenuOpen,
    setIsInterviewActive,
    setLoginView,
    setSignupFormState,
    clearSignupForm,
    handleNavigate,
    handleLogin,
    handleSignUp,
    handleSelectRole,
    handleSignInOrSignUpWithGoogle,
    handleLoginWithGoogle,
    handleLogout,
    handleCancelSignUp,
    toggleTheme,
    handleProfileUpdate,
    handleDeleteAccount,
    saveCurrentChat,
    startChatWithEvaluationContext,
    refreshEvaluations,
    generateUserProfileJsonForChat,
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
