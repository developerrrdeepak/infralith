
'use client';

import { DollarSign, Clock, Users, Building } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { cn } from '@/lib/utils';
import { useAppContext } from '@/contexts/app-context';

const initialMockData = [
    { name: 'Jan', cost: 4000 },
    { name: 'Feb', cost: 3200 },
    { name: 'Mar', cost: 4800 },
    { name: 'Apr', cost: 7200 },
    { name: 'May', cost: 5800 },
    { name: 'Jun', cost: 8500 },
    { name: 'Jul', cost: 7100 },
];

export default function CostPrediction() {
    const { infralithResult } = useAppContext();
    const costData = infralithResult?.cost;

    const formatCurrency = (val: number) => {
        if (val >= 1000000) return `$${(val / 1000000).toFixed(1)}M`;
        if (val >= 1000) return `$${(val / 1000).toFixed(0)}k`;
        return `$${val}`;
    };

    const metrics = [
        {
            title: 'Material Cost',
            val: costData ? formatCurrency(costData.breakdown.find((b: any) => b.category === 'Materials')?.cost || 0) : '$1.2M',
            icon: Building,
            trend: '+5%',
            color: 'text-blue-500'
        },
        {
            title: 'Labor Cost',
            val: costData ? formatCurrency(costData.breakdown.find((b: any) => b.category.includes('Labor'))?.cost || 0) : '$850k',
            icon: Users,
            trend: '-2%',
            color: 'text-green-500'
        },
        {
            title: 'Timeline',
            val: '14 mo',
            icon: Clock,
            trend: 'On Track',
            color: 'text-purple-500'
        },
        {
            title: 'Total Budget',
            val: costData ? formatCurrency(costData.totalEstimatedCost) : '$2.4M',
            icon: DollarSign,
            trend: '+3%',
            color: 'text-amber-500'
        },
    ];

    return (
        <div className="space-y-6 max-w-7xl mx-auto">
            <div className="flex flex-col gap-2">
                <h1 className="text-4xl font-black tracking-tight"><span className="text-gradient">Project Cost</span> Prediction</h1>
                <CardDescription className="text-sm font-medium mt-1">
                    Algorithmic forecast based on real-time market material rates.
                </CardDescription>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                {metrics.map((item, idx) => (
                    <Card key={idx} className="premium-glass premium-glass-hover relative overflow-hidden group">
                        <div className={cn("absolute top-0 right-0 p-4 opacity-5 pointer-events-none group-hover:opacity-20 transition-all group-hover:scale-110", item.color)}>
                            <item.icon className="h-20 w-20 transform -translate-y-4 translate-x-4" />
                        </div>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 relative z-10">
                            <CardTitle className="text-xs font-bold uppercase tracking-wider opacity-60 flex items-center gap-2">
                                <item.icon className="h-4 w-4" /> {item.title}
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="relative z-10">
                            <div className="text-3xl font-bold tracking-tight">{item.val}</div>
                            <div className="flex items-center gap-1.5 mt-2">
                                <Badge variant="outline" className={cn(
                                    "text-[10px] py-0 px-2 border-none font-bold tracking-wider",
                                    item.trend.startsWith('+') ? "bg-red-500/10 text-red-500" : item.trend.startsWith('-') ? "bg-green-500/10 text-green-500" : "bg-blue-500/10 text-blue-500"
                                )}>
                                    {item.trend}
                                </Badge>
                                <span className="text-[10px] text-muted-foreground uppercase opacity-70">vs. last month</span>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <Card className="premium-glass premium-glass-hover relative overflow-hidden group">
                <CardHeader className="flex flex-row items-center justify-between mb-4 border-b border-primary/10 pb-4">
                    <div>
                        <CardTitle className="text-xl font-bold flex items-center gap-2">Expenditure Forecast</CardTitle>
                        <CardDescription className="text-xs mt-1 font-medium">Projected monthly operational burn rate across all sites.</CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="h-2 w-2 rounded-full bg-primary" />
                            Actual
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="h-2 w-2 rounded-full bg-primary/30" />
                            Forecast
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="pt-4">
                    <div className="h-[320px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={initialMockData}>
                                <defs>
                                    <linearGradient id="colorCost" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.3} />
                                        <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <XAxis
                                    dataKey="name"
                                    stroke="#888888"
                                    fontSize={11}
                                    tickLine={false}
                                    axisLine={false}
                                    dy={10}
                                />
                                <YAxis
                                    stroke="#888888"
                                    fontSize={11}
                                    tickLine={false}
                                    axisLine={false}
                                    tickFormatter={(value) => `$${value / 1000}k`}
                                />
                                <Tooltip
                                    contentStyle={{
                                        backgroundColor: 'rgba(0,0,0,0.8)',
                                        border: '1px solid rgba(255,255,255,0.1)',
                                        borderRadius: '8px',
                                        fontSize: '12px'
                                    }}
                                />
                                <Area
                                    type="monotone"
                                    dataKey="cost"
                                    stroke="var(--primary)"
                                    strokeWidth={3}
                                    fillOpacity={1}
                                    fill="url(#colorCost)"
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
