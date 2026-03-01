'use client';
import { useRef, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { User, UserPlus, Upload, ArrowRight, Sparkles, HelpCircle, Eye, EyeOff, X, Loader2, Mail, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAppContext, SignupFormState } from '@/contexts/app-context';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '../ui/form';
import { signIn } from "next-auth/react";

type SignUpView = 'choice' | 'form' | 'quiz' | 'quiz_results';

const signupQuestions = [
  { id: 'favoriteSubjects', question: 'Which subjects or topics do you enjoy the most?', type: 'mcq', options: ['Mathematics', 'Science', 'Technology', 'Literature', 'History', 'Arts', 'Business', 'Other'], required: true },
  { id: 'strongestSkills', question: 'What are your strongest skills?', type: 'mcq', options: ['Technical', 'Creative', 'Analytical', 'Communication', 'Leadership', 'Problem-solving', 'Other'], required: true },
  { id: 'careerMotivation', question: 'What motivates you the most in a career?', type: 'mcq', options: ['Money', 'Stability', 'Creativity', 'Impact', 'Leadership', 'Work-life Balance', 'Growth Opportunities'], required: true },
  { id: 'logicVsCreativity', statement: 'I see myself as more logical/analytical than creative/innovative.', type: 'likert', required: true },
  { id: 'industryPreference', question: 'Which industries are you most interested in?', type: 'mcq', options: ['Technology', 'Healthcare', 'Business', 'Education', 'Arts', 'Finance', 'Government', 'Other'], required: true },
];

// Schemas for each step
const panelOneSchema = z.object({
  firstName: z.string().min(2, "First name is required."),
  lastName: z.string().optional(),
  email: z.string().email("Please enter a valid email."),
  password: z.string().min(6, "Password must be at least 6 characters."),
  confirmPassword: z.string().min(6, "Please confirm your password."),
});

const panelTwoSchema = z.object({
  age: z.string().regex(/^\d+$/, "Please enter a valid age.").min(1, "Age is required."),
  gender: z.string().min(1, "Please select a gender."),
  country: z.string().min(1, "Please select a country."),
  mobile: z.string().regex(/^\d{10}$/, "Please enter a valid 10-digit mobile number."),
});

const panelThreeSchema = z.object({
  language: z.string().min(1, "Please select a language."),
});

const panelFourSchema = z.object({
  fieldOfInterest: z.string().min(3, "Please specify your field of interest."),
});

// A full schema for final submission that merges and then refines.
const fullSignupSchema = z.object({
  ...panelOneSchema.shape,
  ...panelTwoSchema.shape,
  ...panelThreeSchema.shape,
  ...panelFourSchema.shape,
}).refine(data => data.password === data.confirmPassword, {
  message: "Passwords do not match.",
  path: ["confirmPassword"],
});

type SignupFormValues = z.infer<typeof fullSignupSchema>;


const GoogleIcon = () => (
  <svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
  </svg>
);

export default function LoginDialog() {
  // --- CORRECTION 1: Destructure `handleClearAssessmentState` from the context ---
  const { showLogin, setShowLogin, handleLogin, handleSignUp, loginView, setLoginView, signupFormState, setSignupFormState, clearSignupForm, handleClearAssessmentState } = useAppContext();
  const enableLocalAuth = process.env.NODE_ENV !== 'production';
  const [loadingMethod, setLoadingMethod] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signUpView, setSignUpView] = useState<SignUpView>('choice');
  const [interestSuggestions, setInterestSuggestions] = useState<string[]>([]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);

  const MicrosoftIcon = () => (
    <svg className="h-5 w-5 mr-3" viewBox="0 0 23 23" xmlns="http://www.w3.org/2000/svg">
      <path fill="#f3f3f3" d="M0 0h23v23H0z" />
      <path fill="#f35325" d="M1 1h10v10H1z" />
      <path fill="#81bc06" d="M12 1h10v10H12z" />
      <path fill="#05a6f0" d="M1 12h10v10H1z" />
      <path fill="#ffba08" d="M12 12h10v10H12z" />
    </svg>
  );

  const submitMicrosoftLogin = async () => {
    setLoadingMethod('microsoft');
    try {
      await signIn('azure-ad', { callbackUrl: '/' });
    } catch (error) {
      console.error("Microsoft Sign-In failed:", error);
    } finally {
      setLoadingMethod(null);
    }
  };

  const form = useForm<SignupFormValues>({
    resolver: zodResolver(fullSignupSchema),
    defaultValues: {
      ...signupFormState,
      firstName: signupFormState.firstName || '',
      email: signupFormState.email || '',
      age: signupFormState.age || '',
      gender: signupFormState.gender || '',
      country: signupFormState.country || '',
      mobile: signupFormState.mobile || '',
      language: signupFormState.language || '',
      fieldOfInterest: signupFormState.fieldOfInterest || '',
      password: signupFormState.password || '',
      confirmPassword: signupFormState.confirmPassword || '',
    },
  });

  const watchedFieldOfInterest = form.watch("fieldOfInterest");

  useEffect(() => {
    form.reset({
      ...signupFormState,
      firstName: signupFormState.firstName || '',
      email: signupFormState.email || '',
      age: signupFormState.age || '',
      gender: signupFormState.gender || '',
      country: signupFormState.country || '',
      mobile: signupFormState.mobile || '',
      language: signupFormState.language || '',
      fieldOfInterest: signupFormState.fieldOfInterest || '',
      password: signupFormState.password || '',
      confirmPassword: signupFormState.confirmPassword || '',
    });
  }, [signupFormState, form]);

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.onloadend = () => setSignupFormState(prev => ({ ...prev, avatar: reader.result as string }));
      reader.readAsDataURL(file);
    }
  };

  const submitLogin = async () => {
    setLoadingMethod('email');
    try {
      await handleLogin(email, password);
    } catch (error) {
      console.error("Login failed:", error);
    } finally {
      setLoadingMethod(null);
    }
  };

  const onFinalSubmit = form.handleSubmit(async (data) => {
    setLoadingMethod('signup');
    try {
      await handleSignUp(data as any);
    } catch (error) {
      console.error("Sign-up failed:", error);
    } finally {
      setLoadingMethod(null);
    }
  });

  const handleNextStep = async () => {
    const currentStep = signupFormState.currentStep || 1;
    let fieldsToValidate: (keyof SignupFormValues)[] = [];

    if (currentStep === 1) fieldsToValidate = ['firstName', 'email', 'password', 'confirmPassword'];
    else if (currentStep === 2) fieldsToValidate = ['age', 'gender', 'country', 'mobile'];
    else if (currentStep === 3) fieldsToValidate = ['language'];
    else if (currentStep === 4) fieldsToValidate = ['fieldOfInterest'];

    const result = await form.trigger(fieldsToValidate);

    if (result) {
      const values = form.getValues();
      setSignupFormState(prev => ({ ...prev, ...values, currentStep: (prev.currentStep || 1) + 1 }));
    }
  };

  const handleBackStep = () => {
    const values = form.getValues();
    setSignupFormState(prev => ({ ...prev, ...values, currentStep: (prev.currentStep || 2) - 1 }));
  };

  const handleQuizComplete = async (answers: any) => {
    setIsSuggesting(true);
    setSignUpView('quiz_results');
    try {
      const res = await fetch('/api/path-finder-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });
      const data = await res.json();
      setInterestSuggestions(data.roles || ['Structural Engineering', 'Civil Engineering', 'Project Management']);
    } catch (e) {
      console.error("Failed to get suggestions:", e);
      setInterestSuggestions(['Structural Engineering', 'Civil Engineering', 'Project Management']);
    } finally {
      setIsSuggesting(false);
    }
  };

  const switchToSignup = () => {
    clearSignupForm();
    setLoginView('signup');
    setSignUpView('choice');
  };

  const switchToLogin = () => {
    clearSignupForm();
    setLoginView('login');
  };

  const renderLogin = () => (
    <>
      <div className="flex items-center gap-3 mb-4"><User className="h-5 w-5 text-primary" /><h2 className="text-lg font-headline font-semibold">Supervisor Access</h2></div>
      <p className="text-muted-foreground text-sm mb-4">Sign in with your enterprise account to access Infralith.</p>

      <div className="space-y-3">
        <Button variant="default" className="w-full bg-[#2F2F2F] hover:bg-[#3F3F3F] text-white h-12" onClick={submitMicrosoftLogin} disabled={!!loadingMethod}>
          {loadingMethod === 'microsoft' ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Please wait...</> : <><MicrosoftIcon /> Sign in with Microsoft Entra ID</>}
        </Button>
      </div>

      {enableLocalAuth && (
        <>
          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-white/10" /></div>
            <div className="relative flex justify-center text-xs uppercase"><span className="bg-background px-2 text-muted-foreground">Or local developer sign in</span></div>
          </div>

          <div className="space-y-3">
            <Input placeholder="Work Email" value={email} onChange={(e) => setEmail(e.target.value)} type="email" disabled={!!loadingMethod} />
            <div className="relative">
              <Input type={showPassword ? "text" : "password"} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submitLogin()} disabled={!!loadingMethod} />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground">{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
            </div>
            <Button className="w-full" onClick={submitLogin} disabled={!!loadingMethod}>
              {loadingMethod === 'email' ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Please wait...</> : 'Sign In'}
            </Button>
          </div>
        </>
      )}

      <Button variant="link" className="w-full text-xs mt-4 opacity-50 hover:opacity-100" onClick={switchToSignup} disabled={!!loadingMethod}>Register a New Site / Supervisor</Button>
    </>
  );

  const renderSignupChoice = () => (
    <motion.div key="choice" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="flex items-center gap-3 mb-2"><UserPlus className="h-5 w-5 text-primary" /><h2 className="text-lg font-headline font-semibold">Join Infralith</h2></div>
      <p className="text-muted-foreground text-sm mb-6">Create a supervisor account to start evaluating construction blueprints.</p>

      <div className="space-y-3">
        <Button variant="default" className="w-full bg-[#2F2F2F] hover:bg-[#3F3F3F] text-white h-12" onClick={submitMicrosoftLogin} disabled={!!loadingMethod}>
          {loadingMethod === 'microsoft' ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Please wait...</> : <><MicrosoftIcon /> Sign up with Microsoft ID</>}
        </Button>
        <Button variant="outline" className="w-full h-12" onClick={() => setSignUpView('form')} disabled={!!loadingMethod}><Mail className="h-5 w-5 mr-3" />Register with corporate email</Button>
      </div>
      <div className="text-center mt-6"><Button variant="link" className="text-xs" onClick={switchToLogin} disabled={!!loadingMethod}>Already have an account? Sign In</Button></div>
    </motion.div>
  );

  const renderMultiStepForm = () => {
    const currentStep = signupFormState.currentStep || 1;
    const progress = (currentStep / 4) * 100;
    return (
      <Form {...form}>
        <form onSubmit={onFinalSubmit}>
          <div className="flex items-center gap-3 mb-4"><UserPlus className="h-5 w-5 text-primary" /><h2 className="text-lg font-headline font-semibold">Create Supervisor Account</h2></div>
          <p className="text-muted-foreground text-sm mb-4">Just a few details to set up your project evaluation dashboard.</p>
          <Progress value={progress} className="mb-4 h-2" />
          <AnimatePresence mode="wait">
            <motion.div key={currentStep} initial={{ opacity: 0, x: 50 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -50 }} transition={{ duration: 0.3 }}>
              {currentStep === 1 && renderPanelOne()}
              {currentStep === 2 && renderPanelTwo()}
              {currentStep === 3 && renderPanelThree()}
              {currentStep === 4 && renderPanelFour()}
            </motion.div>
          </AnimatePresence>
          <div className="mt-6 flex items-center justify-between">
            <div>
              {currentStep > 1 && (
                <Button variant="ghost" type="button" onClick={handleBackStep} disabled={!!loadingMethod}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back
                </Button>
              )}
            </div>
            <div>
              {currentStep < 4 ? (
                <Button size="sm" type="button" onClick={handleNextStep} disabled={!!loadingMethod}>
                  Next <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              ) : (
                <Button type="submit" disabled={!!loadingMethod}>
                  {loadingMethod === 'signup' ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating Account...</> : 'Finish & Create Account'}
                </Button>
              )}
            </div>
          </div>
          <div className="mt-2 text-center">
            <Button variant="link" className="w-full text-xs" onClick={switchToLogin} disabled={!!loadingMethod}>
              Already have an account? Sign In
            </Button>
          </div>
        </form>
      </Form>
    );
  }

  const renderPanelOne = () => (
    <div className="space-y-4">
      <h3 className="font-semibold">Step 1: Personal Information</h3>
      <div className='flex items-center gap-4'>
        <Avatar className='h-16 w-16'><AvatarImage src={signupFormState.avatar || undefined} alt="Avatar Preview" /><AvatarFallback className='text-xs'>Photo</AvatarFallback></Avatar>
        <Button variant="outline" type="button" onClick={() => photoRef.current?.click()} className="flex-1"><Upload className="h-4 w-4 mr-2" /> Upload Photo</Button>
        <input type="file" ref={photoRef} onChange={handlePhotoChange} className="hidden" accept="image/*" />
      </div>
      <div className="flex gap-3">
        <FormField control={form.control} name="firstName" render={({ field }) => <FormItem><FormControl><Input placeholder="First Name *" {...field} /></FormControl><FormMessage /></FormItem>} />
        <FormField control={form.control} name="lastName" render={({ field }) => <FormItem><FormControl><Input placeholder="Last Name" {...field} /></FormControl><FormMessage /></FormItem>} />
      </div>
      <FormField control={form.control} name="email" render={({ field }) => <FormItem><FormControl><Input type="email" placeholder="Email Address *" {...field} /></FormControl><FormMessage /></FormItem>} />
      <FormField control={form.control} name="password" render={({ field }) => <FormItem><FormControl><Input type={showPassword ? "text" : "password"} placeholder="Create Password *" {...field} /></FormControl><FormMessage /></FormItem>} />
      <FormField control={form.control} name="confirmPassword" render={({ field }) => <FormItem><FormControl><Input type={showPassword ? "text" : "password"} placeholder="Confirm Password *" {...field} /></FormControl><FormMessage /></FormItem>} />
    </div>
  );

  const renderPanelTwo = () => (
    <div className="space-y-4">
      <h3 className="font-semibold">Step 2: Demographics</h3>
      <FormField control={form.control} name="age" render={({ field }) => <FormItem><FormControl><Input type="number" placeholder="Age *" {...field} /></FormControl><FormMessage /></FormItem>} />
      <FormField control={form.control} name="gender" render={({ field }) => <FormItem><Select onValueChange={field.onChange} defaultValue={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Gender *" /></SelectTrigger></FormControl><SelectContent><SelectItem value="male">Male</SelectItem><SelectItem value="female">Female</SelectItem><SelectItem value="other">Other</SelectItem></SelectContent></Select><FormMessage /></FormItem>} />
      <FormField control={form.control} name="country" render={({ field }) => <FormItem><Select onValueChange={field.onChange} defaultValue={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Country *" /></SelectTrigger></FormControl><SelectContent><SelectItem value="india">India</SelectItem><SelectItem value="usa">United States</SelectItem><SelectItem value="uk">United Kingdom</SelectItem></SelectContent></Select><FormMessage /></FormItem>} />
      <FormField control={form.control} name="mobile" render={({ field }) => <FormItem><FormControl><Input type="tel" placeholder="Contact No (10 digits) *" {...field} maxLength={10} /></FormControl><FormMessage /></FormItem>} />
    </div>
  );

  const renderPanelThree = () => (
    <div className="space-y-4">
      <h3 className="font-semibold">Step 3: Preferences</h3>
      <FormField control={form.control} name="language" render={({ field }) => <FormItem><Select onValueChange={field.onChange} defaultValue={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Preferred Language *" /></SelectTrigger></FormControl><SelectContent><SelectItem value="english">English</SelectItem><SelectItem value="hindi">Hindi</SelectItem></SelectContent></Select><FormMessage /></FormItem>} />
    </div>
  );

  const renderPanelFour = () => (
    <div className="space-y-4">
      <h3 className="font-semibold">Step 4: Field of Interest</h3>
      <div className="flex items-center gap-2 text-primary"><Sparkles className="h-5 w-5" /><p className="text-sm font-medium">Primary Engineering Domain *</p></div>
      <FormField control={form.control} name="fieldOfInterest" render={({ field }) => <FormItem><FormControl><Input placeholder="e.g., Structural Engineering" {...field} /></FormControl><FormMessage /></FormItem>} />
      <div className="flex flex-wrap gap-2">{['Structural', 'Civil', 'Electrical', 'Project Management'].map(role => (<Button key={role} type="button" variant={form.getValues("fieldOfInterest") === role ? 'default' : 'outline'} size="sm" onClick={() => form.setValue("fieldOfInterest", role, { shouldValidate: true })}>{role}</Button>))}</div>
    </div>
  );

  const renderQuizResults = () => {
    const field = watchedFieldOfInterest;
    return (
      <div>
        <h3 className="font-semibold text-center">Choose Your Career Path</h3>
        <p className="text-sm text-muted-foreground text-center mb-4">Select the role that excites you most.</p>
        {isSuggesting ? <div className='text-center'><Loader2 className="h-6 w-6 animate-spin mx-auto" /></div> : (
          <div className="flex flex-col gap-3 items-center">
            {interestSuggestions.map((role, idx) => (
              <Button
                key={idx}
                type="button"
                size="lg"
                variant={field === role ? "default" : "outline"}
                onClick={() => form.setValue("fieldOfInterest", role, { shouldValidate: true, shouldDirty: true })}
                className="w-full"
              >
                {role}
              </Button>
            ))}
          </div>
        )}
        {field && (
          <div className="flex justify-center mt-4">
            <Button type="button" onClick={() => setSignUpView("form")}>
              Continue with {field}
            </Button>
          </div>
        )}
      </div>
    )
  };

  const renderSignUp = () => {
    switch (signUpView) {
      case 'quiz': return <div className="p-8 text-center">Quiz Feature Unavailable</div>;
      case 'quiz_results': return renderQuizResults();
      case 'form': return renderMultiStepForm();
      default: return renderSignupChoice();
    }
  };

  if (!showLogin) return null;

  return (
    <motion.div className="fixed inset-0 z-50 flex items-center justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <motion.div key={loginView + signUpView} initial={{ y: 20, opacity: 0, scale: 0.95 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: 20, opacity: 0, scale: 0.95 }} transition={{ duration: 0.2, ease: 'easeOut' }} className="relative z-10 w-[90%] max-w-md rounded-2xl premium-glass p-8 shadow-2xl">
        <Button variant="ghost" size="icon" className="absolute top-4 right-4 h-8 w-8 rounded-full hover:bg-white/10" onClick={() => setShowLogin(false)}><X className="h-4 w-4" /><span className="sr-only">Close</span></Button>
        {loginView === 'login' && renderLogin()}
        {loginView === 'signup' && renderSignUp()}
      </motion.div>
    </motion.div>
  );
}
