
'use client';

import { useState } from 'react';
import {
    Search,
    Loader2,
    Database,
    FileText,
    Network,
    Users,
    User,
    ArrowRight,
    CheckCircle2,
    Zap,
    Target,
    MapPin,
    History,
    MessageCircle
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { searchCosmosDB } from '@/ai/flows/infralith/search-agent';
import { motion } from 'framer-motion';

export default function AzureAISearchView() {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);
    const [activeTab, setActiveTab] = useState('search');

    const handleSearch = async () => {
        if (!query.trim()) return;
        setLoading(true);
        setHasSearched(true);

        // Server action to query backend Cosmos DB mock
        const hits = await searchCosmosDB(query);
        setResults(hits);

        setLoading(false);
    };

    const experts = [
        {
            name: "Marcus Thorne",
            role: "Sr. Infrastructure Observer",
            expertise: ["Seismic Design", "Deep Foundation"],
            projects: ["Mumbai Metro Ph1", "Bangalore Hub"],
            contribution: "Solved structural load variance issue in Bangalore Phase 2 using helical piles."
        },
        {
            name: "Dr. Sarah Chen",
            role: "Structural Lead Engineer",
            expertise: ["Wind Dynamics", "Glassmorphism Architecture"],
            projects: ["Singapore Terminal 5", "Mumbai Sea Link"],
            contribution: "Optimized facade wind resistance by 12% in Mumbai project."
        }
    ];

    return (
        <div className="max-w-6xl mx-auto space-y-8 pb-20">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div className="flex flex-col gap-1">
                    <h1 className="text-4xl font-black tracking-tight flex items-center gap-3 text-slate-900 dark:text-white">
                        <Database className="h-10 w-10 text-primary" /> <span className="text-gradient">Infrastructure</span> Intelligence
                    </h1>
                    <p className="text-slate-500 dark:text-muted-foreground font-medium">Semantic search and organizational knowledge graph powered by Azure AI.</p>
                </div>

                <Tabs value={activeTab} onValueChange={setActiveTab} className="bg-slate-100 dark:bg-white/5 p-1 rounded-xl border border-slate-200 dark:border-white/10">
                    <TabsList className="bg-transparent">
                        <TabsTrigger value="search" className="data-[state=active]:bg-primary data-[state=active]:text-white gap-2 font-bold px-6">
                            <Search className="h-4 w-4" /> Semantic Search
                        </TabsTrigger>
                        <TabsTrigger value="graph" className="data-[state=active]:bg-primary data-[state=active]:text-white gap-2 font-bold px-6">
                            <Network className="h-4 w-4" /> Expert Graph
                        </TabsTrigger>
                    </TabsList>
                </Tabs>
            </div>

            <TabsContent value="search" className="mt-0 space-y-6">
                <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-white/5 shadow-sm p-1 transition-colors">
                    <CardContent className="p-6">
                        <div className="flex flex-col md:flex-row gap-4">
                            <div className="relative flex-1">
                                <Search className="absolute left-4 top-4 h-5 w-5 text-muted-foreground" />
                                <Input
                                    placeholder="Ask about historical seismic issues, material durability, or past project solutions..."
                                    className="pl-12 h-14 text-lg bg-slate-50 dark:bg-black/60 border-slate-200 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-primary focus:border-primary transition-all shadow-inner"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                                />
                                <div className="absolute right-4 top-4 flex gap-2">
                                    <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 pointer-events-none">Vector Index: Active</Badge>
                                </div>
                            </div>
                            <Button className="h-14 px-10 font-black bg-primary hover:bg-primary/80 rounded-xl text-lg shadow-lg shadow-primary/20 transition-all active:scale-95" onClick={handleSearch} disabled={loading}>
                                {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : 'Query Azure'}
                            </Button>
                        </div>
                        <div className="mt-4 flex gap-3 flex-wrap">
                            <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest pt-1">Suggestions:</span>
                            {["Mumbai seismic joint", "Bangalore beam failure", "Type-A reinforcement", "Concrete curing protocols"].map(s => (
                                <button key={s} onClick={() => { setQuery(s); }} className="text-xs bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1 rounded-full text-muted-foreground hover:text-white transition-colors">
                                    {s}
                                </button>
                            ))}
                        </div>
                    </CardContent>
                </Card>

                <div className="space-y-4">
                    {loading && (
                        <div className="flex flex-col items-center justify-center p-20 gap-4">
                            <div className="relative">
                                <Loader2 className="h-12 w-12 text-primary animate-spin" />
                                <Database className="absolute top-3.5 left-3.5 h-5 w-5 text-primary/50" />
                            </div>
                            <div className="text-center space-y-1">
                                <span className="font-black text-xl text-white tracking-tight">Accessing Cosmos DB Vector Store</span>
                                <p className="text-sm text-muted-foreground">Calculating semantic embeddings and performing K-Nearest Neighbor search...</p>
                            </div>
                        </div>
                    )}

                    {!loading && hasSearched && results.length === 0 && (
                        <div className="text-center p-20 bg-black/20 rounded-3xl border border-white/5 border-dashed">
                            <FileText className="h-16 w-16 text-muted-foreground mx-auto mb-6 opacity-20" />
                            <h3 className="text-2xl font-bold">No Semantic Matches</h3>
                            <p className="text-muted-foreground max-w-sm mx-auto">Our AI couldn't find exact matches within the blueprint index. Try broadening your query parameters.</p>
                        </div>
                    )}

                    {!loading && results.length > 0 && (
                        <div className="grid gap-6">
                            <div className="flex items-center justify-between">
                                <h3 className="font-bold text-lg flex items-center gap-2">
                                    <Target className="h-5 w-5 text-primary" /> Top Recommended Matches
                                </h3>
                                <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Found {results.length} related documents</div>
                            </div>
                            {results.map((r, i) => (
                                <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: i * 0.1 }}
                                    key={i}
                                >
                                    <Card className="bg-white dark:bg-white/5 border-slate-200 dark:border-white/10 overflow-hidden group hover:border-primary/50 transition-all cursor-pointer relative shadow-sm">
                                        <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full blur-3xl group-hover:bg-primary/10 transition-colors" />
                                        <CardContent className="p-6 flex flex-col gap-4 relative z-10">
                                            <div className="flex justify-between items-start">
                                                <div className="flex items-center gap-3">
                                                    <div className="h-10 w-10 rounded-lg bg-slate-100 dark:bg-black/40 border border-slate-200 dark:border-white/10 flex items-center justify-center text-primary">
                                                        <FileText className="h-5 w-5" />
                                                    </div>
                                                    <div>
                                                        <h4 className="font-bold text-xl group-hover:text-primary transition-colors">{r.title || r.projectScope || 'Indexed Document'}</h4>
                                                        <div className="flex items-center gap-2 mt-0.5">
                                                            <Badge variant="outline" className="text-[10px] h-5 bg-slate-100 dark:bg-black/50 text-indigo-600 dark:text-primary border-slate-200 dark:border-primary/30 uppercase font-black">{r.collection}</Badge>
                                                            <span className="text-[10px] font-bold text-slate-500 dark:text-muted-foreground uppercase flex items-center gap-1">
                                                                <History className="h-3 w-3" /> {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '-'}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="text-right">
                                                    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Match Score</div>
                                                    <div className="text-2xl font-black text-emerald-500">{typeof r.semanticMatchPercentage === 'number' ? `${r.semanticMatchPercentage}%` : 'N/A'}</div>
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                                <div className="md:col-span-2 space-y-2">
                                                    <p className="text-sm text-slate-300 leading-relaxed line-clamp-3">
                                                        {r.summary || 'No retrieved summary available.'}
                                                    </p>
                                                    <div className="flex gap-2">
                                                        <Badge className="bg-white/10 text-white/50 border-none text-[10px]">#{String(r.collection || 'RAG').toUpperCase()}</Badge>
                                                        {r.citationId && (
                                                            <Badge className="bg-white/10 text-white/50 border-none text-[10px]">{r.citationId}</Badge>
                                                        )}
                                                        {r.source && (
                                                            <Badge className="bg-white/10 text-white/50 border-none text-[10px]">{String(r.source).slice(0, 24)}</Badge>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="bg-slate-100 dark:bg-black/40 rounded-xl p-4 border border-slate-200 dark:border-white/5 flex flex-col justify-center gap-3 shadow-inner">
                                                    <div className="flex items-center gap-2">
                                                        <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
                                                        <span className="text-xs font-bold text-slate-700 dark:text-slate-200">Verified by AI Agent</span>
                                                    </div>
                                                    <Button size="sm" variant="outline" className="w-full text-[10px] uppercase font-bold border-primary/20 text-primary hover:bg-primary/10">
                                                        Open Full Analysis <ArrowRight className="ml-2 h-3 w-3" />
                                                    </Button>
                                                </div>
                                            </div>
                                        </CardContent>
                                    </Card>
                                </motion.div>
                            ))}
                        </div>
                    )}
                </div>
            </TabsContent>

            <TabsContent value="graph" className="mt-0 space-y-8">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    {/* Graph Visual Placeholder */}
                    <Card className="lg:col-span-2 bg-slate-950 border-white/10 overflow-hidden relative group h-[600px] flex items-center justify-center">
                        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-primary/10 via-transparent to-transparent opacity-50" />

                        {/* Simulated Graph Nodes */}
                        <div className="relative w-full h-full p-10">
                            <svg className="absolute inset-0 w-full h-full opacity-20" xmlns="http://www.w3.org/2000/svg">
                                <line x1="20%" y1="30%" x2="50%" y2="50%" stroke="currentColor" strokeWidth="2" className="text-primary" />
                                <line x1="80%" y1="30%" x2="50%" y2="50%" stroke="currentColor" strokeWidth="2" className="text-primary" />
                                <line x1="20%" y1="70%" x2="50%" y2="50%" stroke="currentColor" strokeWidth="2" className="text-primary" />
                                <line x1="80%" y1="70%" x2="50%" y2="50%" stroke="currentColor" strokeWidth="2" className="text-primary" />
                            </svg>

                            {/* Central Hub */}
                            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-4 z-10 group/hub cursor-pointer">
                                <div className="h-24 w-24 rounded-full bg-primary/20 border-2 border-primary flex items-center justify-center shadow-[0_0_50px_rgba(var(--primary),0.3)] group-hover/hub:scale-110 transition-transform">
                                    <Zap className="h-10 w-10 text-primary" />
                                </div>
                                <div className="text-center">
                                    <h4 className="font-black text-xl tracking-tight">SEISMIC FAILURES</h4>
                                    <p className="text-[10px] font-bold uppercase tracking-widest text-primary">Core Knowledge Hub</p>
                                </div>
                            </div>

                            {/* Linked Nodes */}
                            <div className="absolute top-[20%] left-[15%] flex flex-col items-center gap-2 group/node cursor-pointer">
                                <div className="h-14 w-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center group-hover/node:bg-primary/20 group-hover/node:border-primary transition-all">
                                    <MapPin className="h-6 w-6 text-emerald-500" />
                                </div>
                                <span className="text-[10px] font-bold uppercase tracking-tighter">Mumbai Ph1</span>
                            </div>

                            <div className="absolute top-[20%] right-[15%] flex flex-col items-center gap-2 group/node cursor-pointer">
                                <div className="h-14 w-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center group-hover/node:bg-primary/20 group-hover/node:border-primary transition-all">
                                    <Users className="h-6 w-6 text-blue-500" />
                                </div>
                                <span className="text-[10px] font-bold uppercase tracking-tighter">Experts (4)</span>
                            </div>

                            <div className="absolute bottom-[20%] left-[15%] flex flex-col items-center gap-2 group/node cursor-pointer">
                                <div className="h-14 w-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center group-hover/node:bg-primary/20 group-hover/node:border-primary transition-all">
                                    <FileText className="h-6 w-6 text-amber-500" />
                                </div>
                                <span className="text-[10px] font-bold uppercase tracking-tighter">Solutions (12)</span>
                            </div>

                            <div className="absolute bottom-[20%] right-[15%] flex flex-col items-center gap-2 group/node cursor-pointer">
                                <div className="h-14 w-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center group-hover/node:bg-primary/20 group-hover/node:border-primary transition-all">
                                    <CheckCircle2 className="h-6 w-6 text-cyan-500" />
                                </div>
                                <span className="text-[10px] font-bold uppercase tracking-tighter">Compliance</span>
                            </div>
                        </div>

                        <div className="absolute bottom-6 left-6 right-6 p-4 bg-black/60 backdrop-blur-xl border border-white/10 rounded-2xl flex justify-between items-center">
                            <div className="flex flex-col gap-1">
                                <span className="text-xs font-bold text-white">Visualizing Connected Infralith Intel</span>
                                <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">124 Relationships mapped across 12 projects</p>
                            </div>
                            <Button size="sm" variant="ghost" className="text-primary font-black uppercase text-[10px] hover:bg-primary/10">Filter View</Button>
                        </div>
                    </Card>

                    {/* Expert Sidebar */}
                    <div className="space-y-6">
                        <div className="flex flex-col gap-1">
                            <h3 className="font-bold text-lg flex items-center gap-2">
                                <Users className="h-5 w-5 text-primary" /> Topic Experts
                            </h3>
                            <p className="text-xs text-muted-foreground font-medium italic">Recommended human intelligence based on the current context.</p>
                        </div>

                        {experts.map((e, i) => (
                            <motion.div
                                key={i}
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: i * 0.2 }}
                            >
                                <Card className="bg-white/5 border-white/10 hover:border-primary/30 transition-all overflow-hidden relative group">
                                    <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none group-hover:opacity-10 transition-opacity">
                                        <User className="h-20 w-20" />
                                    </div>
                                    <CardContent className="p-5 space-y-4">
                                        <div className="flex items-center gap-3">
                                            <div className="h-12 w-12 rounded-full bg-primary/20 border-2 border-primary/30 flex items-center justify-center text-primary font-black text-xl">
                                                {e.name[0]}
                                            </div>
                                            <div>
                                                <h4 className="font-bold text-base leading-none">{e.name}</h4>
                                                <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest mt-1">{e.role}</p>
                                            </div>
                                        </div>

                                        <div className="space-y-3">
                                            <div className="flex flex-wrap gap-1.5">
                                                {e.expertise.map(exp => (
                                                    <Badge key={exp} variant="outline" className="text-[9px] bg-black text-white/50 border-white/10 uppercase font-black px-1.5">{exp}</Badge>
                                                ))}
                                            </div>
                                            <div className="p-3 bg-primary/5 rounded-xl border border-primary/10">
                                                <p className="text-[11px] font-bold text-primary flex items-center gap-1 uppercase tracking-tight mb-1"><Zap className="h-3 w-3" /> Relevant Solution</p>
                                                <p className="text-[11px] text-slate-300 leading-tight italic">"{e.contribution}"</p>
                                            </div>
                                        </div>

                                        <Button className="w-full bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-bold gap-2">
                                            <MessageCircle className="h-3.5 w-3.5" /> Start Consultation
                                        </Button>
                                    </CardContent>
                                </Card>
                            </motion.div>
                        ))}

                        <Card className="bg-primary/10 border-primary/20 border-dashed">
                            <CardContent className="p-6 text-center space-y-4">
                                <div className="h-10 w-10 rounded-full bg-primary/20 flex items-center justify-center mx-auto">
                                    <ArrowRight className="h-5 w-5 text-primary rotate-45" />
                                </div>
                                <div>
                                    <h4 className="font-bold text-sm">View Full Directory</h4>
                                    <p className="text-[10px] text-muted-foreground font-medium mt-1">Access the global Infralith expert network of 1,200+ engineers.</p>
                                </div>
                                <Button size="sm" className="w-full bg-primary font-black uppercase text-[10px]">Open Directory</Button>
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </TabsContent>
        </div>
    );
}
