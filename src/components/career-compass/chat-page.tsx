'use client';
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MessagesSquare, SendIcon, Loader2, Paperclip, X, FileText, Bot } from "lucide-react";
import ChatHistoryPanel from "./chat-history-panel";
import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { chatWithInfralith } from "@/ai/flows/infralith/chat-agent";
import ReactMarkdown from 'react-markdown';

// Typewriter hook that animates text character by character
function useTypewriter(text: string, enabled: boolean, speed = 8) {
  const [displayed, setDisplayed] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!enabled || !text) {
      setDisplayed(text);
      setDone(true);
      return;
    }
    setDisplayed('');
    setDone(false);
    let i = 0;
    // Use a fast interval to stream chunks of characters at once
    const interval = setInterval(() => {
      const chunkSize = Math.max(1, Math.round(text.length / 80));
      i += chunkSize;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) {
        setDisplayed(text);
        setDone(true);
        clearInterval(interval);
      }
    }, speed);
    return () => clearInterval(interval);
  }, [text, enabled]);

  return { displayed, done };
}

// Component that renders a single AI message with typewriter effect
function AIMessage({ content, animate }: { content: string; animate: boolean }) {
  const { displayed, done } = useTypewriter(content, animate, 8);

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none font-medium text-inherit relative">
      <ReactMarkdown>{displayed}</ReactMarkdown>
      {!done && (
        <span className="inline-block w-[2px] h-[1em] bg-primary/70 ml-0.5 align-middle animate-pulse rounded-sm" />
      )}
    </div>
  );
}

export default function ChatPage() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<{ role: 'user' | 'infralith'; content: string; animate?: boolean }[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const handleSelectChat = (id: string | null) => {
    setActiveSessionId(id);
    setMessages([]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAttachedFile(file);
    }
  };

  const handleSend = async () => {
    if ((!input.trim() && !attachedFile) || loading) return;
    const prompt = input.trim() || (attachedFile ? `Analyze this document: ${attachedFile.name}` : "");
    const fileName = attachedFile?.name;
    const fileContent = attachedFile ? "DEEP ANALYSIS: Structural load requirements, IS-456 compliance details, and material specifications for coastal variants." : undefined;

    setInput("");
    setAttachedFile(null);

    setMessages(prev => [...prev, { role: 'user', content: prompt }]);
    setLoading(true);

    const context = messages.map(m => ({ role: m.role, content: m.content }));
    const response = await chatWithInfralith(context, prompt, fileName, fileContent);

    // Mark the newest AI message as animate: true so it gets the typewriter effect
    setMessages(prev => [...prev, { role: 'infralith', content: response, animate: true }]);
    setLoading(false);
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  return (
    <div className="flex flex-col h-[calc(100vh-125px)] gap-3 -mt-2">
      <div className="shrink-0 flex justify-between items-end">
        <div>
          <h1 className="text-xl font-bold font-headline flex items-center gap-2 text-slate-900 dark:text-white">
            <MessagesSquare className="h-5 w-5 text-primary" />
            Infralith Intelligence Chat
          </h1>
          <p className="text-[11px] text-slate-500 dark:text-muted-foreground font-medium">
            Query blueprints, Indian building codes, and project risk. Use ✨ for insights.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant="outline" className="bg-primary/5 border-primary/20 text-primary font-bold px-3 py-1 uppercase text-[9px] tracking-widest">
            Azure OpenAI Active
          </Badge>
        </div>
      </div>

      <div className="flex flex-1 gap-4 min-h-0">
        <Card className="flex-1 flex flex-col min-w-0 bg-white dark:bg-card/20 backdrop-blur-sm border-slate-200 dark:border-white/5 overflow-hidden shadow-sm">
          <CardContent className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center space-y-4 opacity-50 text-slate-400">
                <MessagesSquare className="h-12 w-12 text-primary" />
                <p className="font-medium text-sm">Start a new conversation about structural engineering or compliance.</p>
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={`flex items-end gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {/* AI Avatar */}
                  {m.role === 'infralith' && (
                    <div className="shrink-0 h-8 w-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center shadow-sm mb-1">
                      <Bot className="h-4 w-4 text-primary" />
                    </div>
                  )}

                  <div className={`p-3.5 rounded-2xl max-w-[80%] shadow-sm transition-all
                    ${m.role === 'user'
                      ? 'bg-primary text-slate-900 font-bold rounded-tr-none'
                      : 'bg-slate-50 dark:bg-muted/50 border border-slate-200 dark:border-white/10 text-slate-800 dark:text-slate-100 rounded-tl-none animate-in fade-in slide-in-from-bottom-2 duration-300'
                    }`}
                  >
                    {m.role === 'infralith' ? (
                      <AIMessage content={m.content} animate={m.animate === true} />
                    ) : m.content}
                  </div>
                </div>
              ))
            )}

            {/* Thinking indicator */}
            {loading && (
              <div className="flex items-end gap-2 justify-start">
                <div className="shrink-0 h-8 w-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center shadow-sm mb-1">
                  <Bot className="h-4 w-4 text-primary animate-pulse" />
                </div>
                <div className="p-3.5 bg-slate-50 dark:bg-muted/50 border border-slate-200 dark:border-white/10 rounded-2xl rounded-tl-none shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="flex items-center gap-2">
                    {/* Animated dots */}
                    <span className="flex gap-1 items-center">
                      <span className="h-2 w-2 rounded-full bg-primary/60 animate-bounce [animation-delay:0ms]" />
                      <span className="h-2 w-2 rounded-full bg-primary/60 animate-bounce [animation-delay:150ms]" />
                      <span className="h-2 w-2 rounded-full bg-primary/60 animate-bounce [animation-delay:300ms]" />
                    </span>
                    <span className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-tighter">Infralith Agent thinking...</span>
                  </div>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </CardContent>
          <CardFooter className="p-4 border-t border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-black/40 flex flex-col gap-3">
            {attachedFile && (
              <div className="flex items-center gap-2 self-start bg-primary/10 border border-primary/20 px-3 py-1.5 rounded-lg">
                <FileText className="h-3.5 w-3.5 text-primary" />
                <span className="text-[10px] font-bold text-primary truncate max-w-[200px]">{attachedFile.name}</span>
                <button onClick={() => setAttachedFile(null)} className="ml-1 text-primary/50 hover:text-primary"><X className="h-3 w-3" /></button>
              </div>
            )}
            <div className="flex w-full gap-2">
              <input type="file" ref={fileInputRef} className="hidden" accept=".pdf,.doc,.docx,.txt" onChange={handleFileChange} />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-xl w-12 h-12 shrink-0 border-slate-200 dark:border-white/10 bg-white dark:bg-transparent text-slate-500 hover:text-primary transition-all"
                title="Attach Document Intelligence Source"
              >
                <Paperclip className="h-5 w-5" />
              </Button>
              <input
                type="text"
                className="flex-1 bg-white dark:bg-transparent border border-slate-200 dark:border-white/20 rounded-xl px-4 text-sm font-medium text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all shadow-inner"
                placeholder="Ask about IS-456 standards or structural load bearing..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              />
              <Button onClick={handleSend} disabled={loading || (!input.trim() && !attachedFile)} className="rounded-xl px-6 h-12 bg-primary hover:bg-primary/90 text-slate-900 font-bold">
                <SendIcon className="h-5 w-5" />
              </Button>
            </div>
          </CardFooter>
        </Card>

        <ChatHistoryPanel
          className="w-72 shrink-0 h-full border-slate-200 dark:border-white/5 bg-white dark:bg-card/10 shadow-sm rounded-3xl"
          activeSessionId={activeSessionId}
          onSelectChat={handleSelectChat}
        />
      </div>
    </div>
  );
}