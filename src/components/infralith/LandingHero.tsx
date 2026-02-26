
'use client';

import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { useAppContext } from '@/contexts/app-context';
import { ShieldCheck, Zap, BarChart3, HardHat, ArrowRight, Newspaper, LineChart, FileText, Bot, CheckCircle2 } from 'lucide-react';
import Typewriter from '../career-compass/typewriter';
import QuickTile from '../career-compass/quick-tile';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import TrendingNewsWidget from '../career-compass/trending-news-widget';

const chartData = [
    { name: 'Steel Index', value: 340 },
    { name: 'Concrete', value: 210 },
    { name: 'Labor Cost', value: 450 },
    { name: 'Energy Index', value: 300 },
    { name: 'Regulatory', value: 150 },
];

const mockNews = [
    {
        title: 'New Zoning Regulations for 2026',
        description: 'Updated structural requirements for seismic zones 2 and 3 have been finalized.',
        url: '#',
        imageUrl: 'https://images.unsplash.com/photo-1503387762-592deb58ef4e?auto=format&fit=crop&q=80&w=300',
        'data-ai-hint': 'zoning news'
    },
    {
        title: 'AI in Construction Efficiency Survey',
        description: 'Companies using Document Intelligence report 40% faster blueprint turnaround.',
        url: '#',
        imageUrl: 'https://images.unsplash.com/photo-1581094794329-c8112a89af12?auto=format&fit=crop&q=80&w=300',
        'data-ai-hint': 'efficiency survey'
    },
    {
        title: 'Sustainability Index: Concrete Alternatives',
        description: 'Evaluating the budget impact of carbon-neutral materials in large scale projects.',
        url: '#',
        imageUrl: 'https://images.unsplash.com/photo-1590674867571-67d801998340?auto=format&fit=crop&q=80&w=300',
        'data-ai-hint': 'sustainability'
    },
];

export default function LandingHero() {
    const { setShowLogin, setLoginView } = useAppContext();

    const containerVariants = {
        hidden: { opacity: 0 },
        show: {
            opacity: 1,
            transition: {
                staggerChildren: 0.1
            }
        }
    };

    const itemVariants = {
        hidden: { opacity: 0, y: 15 },
        show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: 'easeOut' } }
    } as any;

    return (
        <motion.div
            className="space-y-32 pb-32"
            variants={containerVariants}
            initial="hidden"
            animate="show"
        >
            {/* 1. Hero Section */}
            <section className="flex flex-col items-center justify-center pt-6 md:pt-10 px-4 text-center space-y-6 md:space-y-8 min-h-[70vh] md:min-h-[auto]">
                <motion.div variants={itemVariants} className="space-y-4 md:space-y-6">
                    <h1 className="text-5xl md:text-6xl lg:text-7xl font-black tracking-tighter max-w-5xl mx-auto leading-[1.1]">
                        <span className="text-gradient">Evaluate</span> <Typewriter words={["Blueprints", "Compliance", "Structural Risk", "Total Cost"]} /> <br />
                        Before Construction Begins
                    </h1>
                    <p className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
                        Infralith is an AI-powered construction intelligence platform orchestrating specialized agents to ensure structural safety, regulatory compliance, and budget accuracy.
                    </p>
                </motion.div>

                <motion.div variants={itemVariants} className="relative mt-8">
                    <div className="absolute inset-0 bg-primary/40 blur-3xl rounded-full opacity-50"></div>
                    <Button size="lg" className="relative z-10 h-14 px-10 text-lg rounded-full shadow-[0_0_40px_rgba(245,158,11,0.4)] font-bold bg-primary hover:bg-primary/90 text-white transition-all hover:scale-105" onClick={() => { setLoginView('signup'); setShowLogin(true); }}>
                        Get Started <ArrowRight className="ml-3 h-5 w-5" />
                    </Button>
                </motion.div>
            </section>

            {/* 2. Intelligence Dashboard Preview (News & Trends) */}
            <section className="px-4 container mx-auto max-w-7xl">
                <motion.div variants={itemVariants} className="grid grid-cols-1 md:grid-cols-2 gap-8 items-stretch">
                    <Card className="premium-glass premium-glass-hover">
                        <CardHeader>
                            <CardTitle className="font-headline flex items-center gap-2 text-xl">
                                <Newspaper className="h-6 w-6 text-primary" /> Trending Construction News
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <TrendingNewsWidget items={mockNews} loading={false} />
                        </CardContent>
                    </Card>

                    <Card className="premium-glass premium-glass-hover">
                        <CardHeader className="flex flex-row items-center justify-between">
                            <CardTitle className="font-headline flex items-center gap-2 text-xl">
                                <LineChart className="h-6 w-6 text-primary" /> Material Cost Trends
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p className="text-sm text-muted-foreground mt-4 leading-relaxed font-medium">
                                Real-time tracking of construction material and labor costs to ensure your project's financial feasibility remains on track.
                            </p>
                        </CardContent>
                    </Card>
                </motion.div>
            </section>

            {/* 3. Value Props (3 Columns) */}
            <section className="px-4 container mx-auto max-w-7xl">
                <motion.div variants={itemVariants} className="grid grid-cols-1 md:grid-cols-3 gap-8">
                    {[
                        { title: 'Global Compliance', desc: 'Auto-verify plans against 240+ regional building codes instantly.', icon: ShieldCheck },
                        { title: 'Structural Analysis', desc: 'Identify 40+ engineering failure modes before ground-break.', icon: Zap },
                        { title: 'Resource Prediction', desc: 'Predict material needs and labor hours with 92% accuracy.', icon: BarChart3 }
                    ].map((feature, i) => (
                        <div key={i} className="premium-glass premium-glass-hover p-10 rounded-3xl space-y-6 relative overflow-hidden group">
                            <div className="absolute top-0 right-0 -mr-8 -mt-8 w-32 h-32 bg-primary/10 rounded-full blur-2xl group-hover:bg-primary/20 transition-all"></div>
                            <feature.icon className="h-10 w-10 text-primary relative z-10" />
                            <h3 className="text-2xl font-bold relative z-10">{feature.title}</h3>
                            <p className="text-muted-foreground text-base relative z-10">{feature.desc}</p>
                        </div>
                    ))}
                </motion.div>
            </section>

            {/* 4. Feature Deep Dives (QuickTiles) */}
            <section className="px-4 container mx-auto max-w-7xl space-y-20">
                <motion.div variants={itemVariants} className="text-center space-y-4">
                    <h2 className="text-4xl md:text-6xl font-black tracking-tight"><span className="text-gradient">AI-Driven</span> Engineering Excellence</h2>
                    <p className="text-xl text-muted-foreground max-w-4xl mx-auto">
                        Our multi-agent architecture coordinates specialized AI models to analyze every facet of your construction project.
                    </p>
                </motion.div>

                <div className="space-y-12">
                    <motion.div variants={itemVariants}>
                        <QuickTile
                            title="Blueprint Extraction Agent"
                            description="OCR and spatial vision models extract accurate dimensions, materials, and architectural symbols from your PDF plans. Using cutting-edge document intelligence, we convert unstructured blueprints into searchable data."
                            icon={<FileText className="h-6 w-6" />}
                            imageUrl="https://images.unsplash.com/photo-1503387762-592deb58ef4e?auto=format&fit=crop&q=80&w=1200"
                            data-ai-hint="blueprint extraction"
                            layout="image-right"
                            onClick={() => { setLoginView('signup'); setShowLogin(true); }}
                        />
                    </motion.div>

                    <motion.div variants={itemVariants}>
                        <QuickTile
                            title="Compliance Analysis Engine"
                            description="Instantly validate designs against building codes and zoning laws. Our dedicated Compliance Agent flags violations in real-time, preventing legal delays and ensuring project safety standards are met."
                            icon={<ShieldCheck className="h-6 w-6" />}
                            imageUrl="https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&q=80&w=1200"
                            data-ai-hint="compliance agent"
                            layout="image-left"
                            onClick={() => { setLoginView('signup'); setShowLogin(true); }}
                        />
                    </motion.div>

                    <motion.div variants={itemVariants}>
                        <QuickTile
                            title="Risk & Safety Evaluation"
                            description="Leverage semantic intelligence agents to analyze historical failure data and identify structural vulnerabilities. From soil composition risks to seismic requirements, get a comprehensive safety score for every plan."
                            icon={<Bot className="h-6 w-6" />}
                            imageUrl="https://images.unsplash.com/photo-1504307651254-35680f356dfd?auto=format&fit=crop&q=80&w=1200"
                            data-ai-hint="risk oracle"
                            layout="image-right"
                            onClick={() => { setLoginView('signup'); setShowLogin(true); }}
                        />
                    </motion.div>
                </div>
            </section>

            {/* 5. Benefits List */}
            <section className="py-32 px-4 border-y border-white/10 relative overflow-hidden">
                <div className="absolute inset-0 bg-primary/5"></div>
                <div className="absolute top-1/2 left-0 w-96 h-96 bg-accent/20 rounded-full blur-[120px] -translate-y-1/2 -translate-x-1/2"></div>
                <div className="container mx-auto max-w-7xl grid grid-cols-1 md:grid-cols-2 gap-20 items-center relative z-10">
                    <motion.div variants={itemVariants} className="space-y-8">
                        <h2 className="text-4xl md:text-5xl font-bold leading-tight tracking-tight">Why Construction Firms Choose <span className="text-gradient">Infralith</span></h2>
                        <div className="space-y-4">
                            {[
                                "Reduce pre-construction review time by 70%",
                                "Eliminate human error in structural due diligence",
                                "Seamless integration with enterprise cloud infrastructure",
                                "Contextual querying of historical project data"
                            ].map((benefit, i) => (
                                <div key={i} className="flex items-center gap-3 text-lg">
                                    <CheckCircle2 className="h-6 w-6 text-primary shrink-0" />
                                    <span>{benefit}</span>
                                </div>
                            ))}
                        </div>
                        <Button size="lg" className="rounded-full h-12 px-8 text-base font-semibold" onClick={() => { setLoginView('signup'); setShowLogin(true); }}>
                            Get Started Now
                        </Button>
                    </motion.div>
                    <motion.div variants={itemVariants} className="relative aspect-video rounded-3xl overflow-hidden border border-white/10 shadow-2xl">
                        <img src="https://images.unsplash.com/photo-1581094794329-c8112a89af12?auto=format&fit=crop&q=80&w=1200" className="object-cover w-full h-full" alt="Tech Dashboard" />
                    </motion.div>
                </div>
            </section>

            {/* 6. Final CTA */}
            <section className="px-4 text-center py-32 relative">
                <div className="absolute top-1/2 left-1/2 w-full h-full max-w-4xl bg-primary/20 blur-[150px] rounded-full -translate-x-1/2 -translate-y-1/2 pointer-events-none"></div>
                <motion.div variants={itemVariants} className="space-y-8 max-w-5xl mx-auto relative z-10">
                    <h2 className="text-5xl md:text-7xl font-black tracking-tight"><span className="text-gradient">One Platform.</span><br />Complete Intelligence.</h2>
                    <p className="text-2xl text-muted-foreground max-w-3xl mx-auto">
                        Join the elite engineering supervisors transforming the industry with AI-powered blueprint analysis.
                    </p>
                    <div className="flex justify-center gap-6 mt-10">
                        <Button size="lg" className="h-16 px-12 text-xl rounded-full font-bold shadow-[0_0_50px_rgba(245,158,11,0.5)] hover:scale-105 transition-all" onClick={() => { setLoginView('signup'); setShowLogin(true); }}>
                            Start Evaluation
                        </Button>
                    </div>
                </motion.div>
            </section>
        </motion.div>
    );
}
