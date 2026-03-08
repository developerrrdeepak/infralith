'use client';

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { History, PlusCircle, Search } from "lucide-react";
import { useAppContext } from "@/contexts/app-context";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface ChatHistoryPanelProps {
    className?: string;
    activeSessionId: string | null;
    onSelectChat: (id: string | null) => void;
}

export default function ChatHistoryPanel({ className, activeSessionId, onSelectChat }: ChatHistoryPanelProps) {
    const { chatHistory } = useAppContext();

    return (
        <Card className={cn("hidden lg:flex flex-col", className)}>
            <CardHeader className="py-4">
                <CardTitle className="font-headline flex items-center justify-between gap-2 text-base">
                    <div className="flex items-center gap-2">
                        <History className="h-4 w-4" />
                        Chat History
                    </div>
                    <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => onSelectChat(null)}>
                        <PlusCircle className="h-3.5 w-3.5 mr-1" /> New
                    </Button>
                </CardTitle>
                <div className="relative mt-2">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input placeholder="Search history..." className="pl-8 h-8 text-xs" />
                </div>
            </CardHeader>
            <CardContent className="flex-1 min-h-0 flex flex-col p-4 pt-0">
                <ScrollArea className="flex-1">
                    {chatHistory.length > 0 ? (
                        <div className="space-y-1">
                            {chatHistory.map(session => (
                                <button
                                    key={session.id}
                                    onClick={() => onSelectChat(session.id)}
                                    className={cn(
                                        "w-full text-left p-2 rounded-md transition-colors",
                                        activeSessionId === session.id
                                            ? "bg-primary/10 text-primary"
                                            : "hover:bg-muted"
                                    )}
                                >
                                    <p className="text-xs font-medium truncate">{session.title}</p>
                                    <p className="text-[10px] text-muted-foreground">
                                        {new Date(session.timestamp).toLocaleDateString()}
                                    </p>
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div className="text-center text-muted-foreground py-8 border-2 border-dashed rounded-lg">
                            <p className="text-xs">No conversations yet.</p>
                        </div>
                    )}
                </ScrollArea>
            </CardContent>
        </Card>
    );
}
