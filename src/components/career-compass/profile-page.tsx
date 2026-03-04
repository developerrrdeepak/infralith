'use client';

import { useState, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useAppContext } from "@/contexts/app-context";
import { cn } from "@/lib/utils";
import { Edit, X, Loader2, User as UserIcon, GraduationCap, Briefcase, Link as LinkIcon, Camera } from "lucide-react";
import { Skeleton } from "../ui/skeleton";

import { useToast } from "@/hooks/use-toast";

// Updated Zod schema: Most fields are now optional
const profileFormSchema = z.object({
    name: z.string().optional(),
    email: z.string().email("Please enter a valid email address.").optional(),
    mobile: z.string().optional(),
    // Using string for date input (YYYY-MM-DD)
    dob: z.string().optional(),
    gender: z.string().optional(),
    age: z.coerce.number().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    postalCode: z.string().optional(),
    skills: z.array(z.string()).optional(),
    experience: z.string().optional(),
    college: z.string().optional(),
    degree: z.string().optional(),
    gradYear: z.coerce.number().optional(),
    linkedin: z.string().optional().or(z.literal('')),
    github: z.string().optional().or(z.literal('')),
    portfolio: z.string().optional().or(z.literal('')),
});

type ProfileFormValues = z.infer<typeof profileFormSchema>;

// Helper component for multi-tag skill input
const SkillsInput = ({ field }: { field: any }) => {
    const [inputValue, setInputValue] = useState("");
    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const newSkill = inputValue.trim();
            // Ensure field.value is an array before spreading
            const currentSkills = Array.isArray(field.value) ? field.value : [];
            if (newSkill && !currentSkills.includes(newSkill)) {
                field.onChange([...currentSkills, newSkill]);
            }
            setInputValue("");
        }
    };
    const removeSkill = (skillToRemove: string) => {
        const currentSkills = Array.isArray(field.value) ? field.value : [];
        field.onChange(currentSkills.filter((skill: string) => skill !== skillToRemove));
    };

    const currentSkills = Array.isArray(field.value) ? field.value : [];

    return (
        <div>
            <div className="flex flex-wrap gap-2 mb-2">
                {currentSkills.map((skill: string) => (
                    <div key={skill} className="flex items-center gap-1 bg-primary/10 text-primary text-xs font-semibold px-2 py-1 rounded-full">
                        {skill}
                        <button type="button" onClick={() => removeSkill(skill)}><X className="h-3 w-3" /></button>
                    </div>
                ))}
            </div>
            <Input
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a skill and press Enter"
            />
        </div>
    );
};

export default function ProfilePage() {
    const { user, handleProfileUpdate, isLoadingAuth, handleDeleteAccount } = useAppContext();
    const { toast } = useToast();
    const [isEditMode, setIsEditMode] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    // Avatar upload state
    const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const form = useForm<ProfileFormValues>({
        resolver: zodResolver(profileFormSchema) as any,
        defaultValues: {
            skills: [],
        },
    });

    useEffect(() => {
        if (user) {
            form.reset({
                name: user.name || '',
                email: user.email || '',
                mobile: user.mobile || '',
                // Date input expects YYYY-MM-DD string directly
                dob: user.dob || '',
                gender: user.gender || '',
                age: user.age || undefined,
                city: user.city || '',
                state: user.state || '',
                country: user.country || '',
                postalCode: user.postalCode || '',
                skills: user.skills || [],
                experience: user.experience || '',
                college: user.college || '',
                degree: user.degree || '',
                gradYear: user.gradYear || undefined,
                linkedin: user.linkedin || '',
                github: user.github || '',
                portfolio: user.portfolio || '',
            });
            setAvatarPreview(user.avatar || null);
        }
    }, [user, form]);

    const handleAvatarClick = () => {
        if (isEditMode) {
            fileInputRef.current?.click();
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            if (file.size > 2 * 1024 * 1024) {
                toast({ variant: "destructive", title: "File too large", description: "Max size is 2MB" });
                return;
            }
            const reader = new FileReader();
            reader.onloadend = () => {
                setAvatarPreview(reader.result as string);
            };
            reader.readAsDataURL(file);
        }
    };

    const onSubmit = async (data: ProfileFormValues) => {
        if (!user) return;
        setIsSubmitting(true);
        try {
            const profileData = {
                ...data,
                // No need to format if using native date input (returns YYYY-MM-DD)
                avatar: avatarPreview,
            };
            await handleProfileUpdate({ uid: user.uid, ...profileData });
            setIsEditMode(false);
        } catch (error) {
            console.error("Failed to update profile", error);
        } finally {
            setIsSubmitting(false);
        }
    };

    const onCancel = () => {
        setIsEditMode(false);
        form.reset();
        setAvatarPreview(user?.avatar || null);
    }

    const onDeleteConfirm = async () => {
        setIsDeleting(true);
        try {
            await handleDeleteAccount();
        } catch (error) {
            console.error("Failed to delete account from component", error);
        } finally {
            setIsDeleting(false);
        }
    };

    if (isLoadingAuth || !user) {
        return <Skeleton className="h-[500px] w-full" />;
    }

    return (
        <div className="space-y-6">
            <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)}>
                    <Card className="shadow-sm">
                        <div className="h-32 bg-muted rounded-t-xl" />
                        <CardContent className="p-4 md:p-6">
                            <div className="flex flex-col sm:flex-row items-center sm:items-end -mt-16 sm:-mt-20">
                                {/* Avatar Section with Edit Overlay */}
                                <div className="relative group">
                                    <Avatar className={cn("h-28 w-28 border-4 border-background", isEditMode && "cursor-pointer hover:opacity-90")} onClick={handleAvatarClick}>
                                        <AvatarImage src={avatarPreview || undefined} className="object-cover" />
                                        <AvatarFallback className="text-4xl">{user?.name?.[0]}</AvatarFallback>
                                    </Avatar>
                                    {isEditMode && (
                                        <div
                                            className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-full cursor-pointer transition-opacity opacity-0 group-hover:opacity-100 m-1"
                                            onClick={handleAvatarClick}
                                        >
                                            <Camera className="h-8 w-8 text-white" />
                                        </div>
                                    )}
                                    <input
                                        type="file"
                                        ref={fileInputRef}
                                        className="hidden"
                                        accept="image/*"
                                        onChange={handleFileChange}
                                    />
                                </div>

                                <div className="flex-1 ml-4 mt-4 sm:mt-0 text-center sm:text-left">
                                    <h2 className="text-2xl font-bold font-headline">{user.name}</h2>
                                    <p className="text-sm text-muted-foreground">{user.email}</p>
                                </div>
                                {!isEditMode ? (
                                    <Button variant="outline" onClick={() => setIsEditMode(true)} className="mt-4 sm:mt-0">
                                        <Edit className="h-4 w-4 mr-2" /> Edit Profile
                                    </Button>
                                ) : (
                                    <div className="flex gap-2 mt-4 sm:mt-0">
                                        <Button variant="outline" type="button" onClick={onCancel}>Cancel</Button>
                                        <Button type="submit" disabled={isSubmitting}>
                                            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save Changes
                                        </Button>
                                    </div>
                                )}
                            </div>

                            <div className="mt-6 space-y-6">
                                <Card><CardHeader><CardTitle className="flex items-center gap-2"><UserIcon className="text-primary" />Basic & Address Details</CardTitle></CardHeader><CardContent className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                    <FormField control={form.control} name="name" render={({ field }) => (<FormItem><FormLabel>Full Name</FormLabel><FormControl><Input {...field} readOnly={!isEditMode} /></FormControl><FormMessage /></FormItem>)} />
                                    <FormField control={form.control} name="email" render={({ field }) => (<FormItem><FormLabel>Email</FormLabel><FormControl><Input {...field} readOnly={!isEditMode} type="email" disabled /></FormControl><FormMessage /></FormItem>)} />
                                    <FormField control={form.control} name="mobile" render={({ field }) => (<FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} readOnly={!isEditMode} type="tel" /></FormControl><FormMessage /></FormItem>)} />

                                    {/* ENABLED TYPING FOR DATE OF BIRTH */}
                                    <FormField control={form.control} name="dob" render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Date of Birth</FormLabel>
                                            <FormControl>
                                                <Input
                                                    type="date"
                                                    {...field}
                                                    readOnly={!isEditMode}
                                                    // Ensure value is never null to avoid uncontrolled input warnings
                                                    value={field.value || ''}
                                                />
                                            </FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )} />

                                    <FormField control={form.control} name="gender" render={({ field }) => (<FormItem><FormLabel>Gender</FormLabel><Select onValueChange={field.onChange} defaultValue={field.value} disabled={!isEditMode}><FormControl><SelectTrigger><SelectValue placeholder="Select gender" /></SelectTrigger></FormControl><SelectContent><SelectItem value="male">Male</SelectItem><SelectItem value="female">Female</SelectItem><SelectItem value="other">Other</SelectItem></SelectContent></Select><FormMessage /></FormItem>)} />
                                    <FormField control={form.control} name="age" render={({ field }) => (<FormItem><FormLabel>Age</FormLabel><FormControl><Input {...field} readOnly={!isEditMode} type="number" /></FormControl><FormMessage /></FormItem>)} />
                                    <FormField control={form.control} name="city" render={({ field }) => (<FormItem><FormLabel>City</FormLabel><FormControl><Input {...field} readOnly={!isEditMode} /></FormControl><FormMessage /></FormItem>)} />
                                    <FormField control={form.control} name="state" render={({ field }) => (<FormItem><FormLabel>State</FormLabel><FormControl><Input {...field} readOnly={!isEditMode} /></FormControl><FormMessage /></FormItem>)} />
                                    <FormField control={form.control} name="country" render={({ field }) => (<FormItem><FormLabel>Country</FormLabel><FormControl><Input {...field} readOnly={!isEditMode} /></FormControl><FormMessage /></FormItem>)} />
                                    <FormField control={form.control} name="postalCode" render={({ field }) => (<FormItem><FormLabel>Postal Code</FormLabel><FormControl><Input {...field} readOnly={!isEditMode} type="text" /></FormControl><FormMessage /></FormItem>)} />
                                </CardContent></Card>

                                <Card><CardHeader><CardTitle className="flex items-center gap-2"><GraduationCap className="text-primary" />Education</CardTitle></CardHeader><CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    <FormField control={form.control} name="college" render={({ field }) => (<FormItem><FormLabel>College/University</FormLabel><FormControl><Input {...field} readOnly={!isEditMode} /></FormControl><FormMessage /></FormItem>)} />
                                    <FormField control={form.control} name="degree" render={({ field }) => (<FormItem><FormLabel>Degree</FormLabel><FormControl><Input {...field} readOnly={!isEditMode} /></FormControl><FormMessage /></FormItem>)} />
                                    <FormField control={form.control} name="gradYear" render={({ field }) => (<FormItem><FormLabel>Year of Graduation</FormLabel><FormControl><Input {...field} readOnly={!isEditMode} type="number" /></FormControl><FormMessage /></FormItem>)} />
                                </CardContent></Card>

                                <Card><CardHeader><CardTitle className="flex items-center gap-2"><Briefcase className="text-primary" />Professional Info</CardTitle></CardHeader><CardContent className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <FormField control={form.control} name="skills" render={({ field }) => (<FormItem><FormLabel>Skills</FormLabel><FormControl>{isEditMode ? <SkillsInput field={field} /> : <div className="flex flex-wrap gap-2">{(field.value || []).map((skill: string) => <div key={skill} className="bg-muted text-sm px-3 py-1 rounded">{skill}</div>)}</div>}</FormControl><FormMessage /></FormItem>)} />
                                    <FormField control={form.control} name="experience" render={({ field }) => (<FormItem><FormLabel>Work Experience / Internships</FormLabel><FormControl><Textarea {...field} readOnly={!isEditMode} placeholder="Describe your roles and responsibilities..." /></FormControl><FormMessage /></FormItem>)} />
                                </CardContent></Card>

                                <Card><CardHeader><CardTitle className="flex items-center gap-2"><LinkIcon className="text-primary" />Social & Professional Links</CardTitle></CardHeader><CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    <FormField control={form.control} name="linkedin" render={({ field }) => (<FormItem><FormLabel>LinkedIn</FormLabel><FormControl><Input {...field} readOnly={!isEditMode} placeholder="https://linkedin.com/in/..." /></FormControl><FormMessage /></FormItem>)} />
                                    <FormField control={form.control} name="github" render={({ field }) => (<FormItem><FormLabel>GitHub</FormLabel><FormControl><Input {...field} readOnly={!isEditMode} placeholder="https://github.com/..." /></FormControl><FormMessage /></FormItem>)} />
                                    <FormField control={form.control} name="portfolio" render={({ field }) => (<FormItem><FormLabel>Portfolio</FormLabel><FormControl><Input {...field} readOnly={!isEditMode} placeholder="https://..." /></FormControl><FormMessage /></FormItem>)} />
                                </CardContent></Card>
                            </div>
                        </CardContent>
                    </Card>
                </form>
            </Form>


            <Card className="border-destructive/50">
                <CardHeader>
                    <CardTitle className="font-headline text-destructive">Danger Zone</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between">
                        <div>
                            <h3 className="font-semibold">Delete Your Account</h3>
                            <p className="text-sm text-muted-foreground mt-1 max-w-xl">Once you delete your account, there is no going back. All your profile data, evaluations, and chat history will be permanently removed. Please be certain.</p>
                        </div>
                        <AlertDialog>
                            <AlertDialogTrigger asChild>
                                <Button variant="destructive" className="mt-4 sm:mt-0">Delete Profile</Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                                <AlertDialogHeader>
                                    <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                                    <AlertDialogDescription>This action cannot be undone. This will permanently delete your account and remove your data from our servers.</AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={onDeleteConfirm} disabled={isDeleting}>{isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Yes, delete my account</AlertDialogAction></AlertDialogFooter>
                            </AlertDialogContent>
                        </AlertDialog>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
