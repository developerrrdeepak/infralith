'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import { useAppContext } from '@/contexts/app-context';
import { userDbService, inviteService, ChatSummary, ChatMessage, UserProfileData, normalizeEmail } from '@/lib/services';
import { dmService } from '@/lib/collab-client';
import { Card } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Send, MessageCircle, AlertCircle, Check, Trash2, X, Plus, Image as ImageIcon, ShieldCheck, Search, Users, Video, Mail, UserCheck, UserPlus } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';

export default function DMPage() {
  const { user } = useAppContext();
  const { toast } = useToast();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [selectedChat, setSelectedChat] = useState<ChatSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // New Chat Dialog State
  const [allUsers, setAllUsers] = useState<UserProfileData[]>([]);
  const [searchUser, setSearchUser] = useState('');
  const [isNewChatOpen, setIsNewChatOpen] = useState(false);
  const [isGroupDialogActive, setIsGroupDialogActive] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selectedEngineers, setSelectedEngineers] = useState<string[]>([]);
  const [emailLookupResult, setEmailLookupResult] = useState<'idle' | 'loading' | 'found_member' | 'found_not_member' | 'not_found' | 'invited'>('idle');
  const [emailLookupUser, setEmailLookupUser] = useState<UserProfileData | null>(null);
  const latestLookupId = useRef(0);
  const lookupDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canCreateGroups = user?.role === 'Engineer' || user?.role === 'Supervisor' || user?.role === 'Admin';

  const fetchChats = useCallback(async () => {
    if (!user) return;
    try {
      const list = await dmService.getUserChats(user.uid);
      if (
        list.length === 0 &&
        process.env.NODE_ENV !== 'production' &&
        !sessionStorage.getItem('infralith_dm_seeded')
      ) {
        await dmService.seedMockDMs(user.uid);
        sessionStorage.setItem('infralith_dm_seeded', 'true');
        return;
      }
      setChats(list.sort((a, b) => b.timestamp - a.timestamp));
    } catch (error) {
      console.error('Failed to fetch chats:', error);
    }
  }, [user]);

  const fetchMessages = useCallback(async () => {
    if (!selectedChat) {
      setMessages([]);
      return;
    }
    try {
      const msgs = await dmService.getMessages(selectedChat.chatId);
      setMessages(msgs.sort((a, b) => a.timestamp - b.timestamp));
    } catch (error) {
      console.error('Failed to fetch messages:', error);
    }
  }, [selectedChat]);

  // 1. Load chat list + realtime stream
  useEffect(() => {
    if (!user?.uid) return;

    void fetchChats();

    const pollTimer = setInterval(() => {
      void fetchChats();
    }, 15000);

    let eventSource: EventSource | null = null;
    const onRealtimeUpdate = () => {
      void fetchChats();
      void fetchMessages();
    };

    if (typeof EventSource !== 'undefined') {
      eventSource = new EventSource('/api/infralith/messages/stream');
      eventSource.addEventListener('update', onRealtimeUpdate);
    }

    return () => {
      clearInterval(pollTimer);
      if (eventSource) {
        eventSource.removeEventListener('update', onRealtimeUpdate);
        eventSource.close();
      }
    };
  }, [user?.uid, fetchChats, fetchMessages]);

  // Load all users on mount for group creation, or when dialog opens
  useEffect(() => {
    if (user && canCreateGroups) {
      userDbService.getAllUsers().then(users => {
        setAllUsers(users.filter(u => u.uid !== user?.uid)); // Filter out current user
      });
    }
  }, [user]);

  // 2. Handle Redirects and Updates - EFFECT
  useEffect(() => {
    const pendingChatId = sessionStorage.getItem('open_chat_id');

    if (pendingChatId && chats.length > 0) {
      const chatToOpen = chats.find(c => c.chatId === pendingChatId);
      if (chatToOpen) {
        setSelectedChat(chatToOpen);
        sessionStorage.removeItem('open_chat_id');
      }
    }

    if (selectedChat && chats.length > 0) {
      const updatedChat = chats.find(c => c.chatId === selectedChat.chatId);
      if (updatedChat && (updatedChat.lastMessage !== selectedChat.lastMessage || updatedChat.status !== selectedChat.status)) {
        setSelectedChat(updatedChat);
      }
    }
  }, [chats, selectedChat]);

  // 3. Load messages when a chat is selected
  useEffect(() => {
    if (!selectedChat) {
      setMessages([]);
      return;
    }

    if (user?.uid) {
      void dmService.markChatRead(user.uid, selectedChat.chatId);
    }
    void fetchMessages();

    const pollTimer = setInterval(() => {
      void fetchMessages();
    }, 10000);

    return () => clearInterval(pollTimer);
  }, [selectedChat?.chatId, user?.uid, fetchMessages]);

  // 4. Auto-scroll to bottom of chat
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, imagePreview]);

  const handleImageSelection = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) { // 2MB limit
        toast({ variant: 'destructive', title: 'Image too large', description: 'Please select an image smaller than 2MB' });
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => setImagePreview(reader.result as string);
      reader.readAsDataURL(file);
    }
    // reset input so the same file can be selected again if removed
    e.target.value = '';
  };

  const removeSelectedImage = () => {
    setImagePreview(null);
  };

  const handleSendMessage = async () => {
    if (!user || !selectedChat || (!newMessage.trim() && !imagePreview)) return;

    const text = newMessage;
    const imgData = imagePreview;

    setNewMessage('');
    setImagePreview(null);

    try {
      await dmService.sendMessage(
        user.uid,
        selectedChat.otherUserId,
        selectedChat.otherUserName,
        selectedChat.otherUserAvatar,
        user.name || user.email || 'Team Member',
        user.avatar || '',
        text,
        imgData
      );
      await dmService.markChatRead(user.uid, selectedChat.chatId);
    } catch (error) {
      toast({ variant: 'destructive', title: 'Message failed', description: 'Unable to send this message right now.' });
    }
  };

  const handleAcceptRequest = async () => {
    if (!user || !selectedChat) return;
    await dmService.acceptChatRequest(user.uid, selectedChat.chatId);
    toast({ title: 'Request accepted', description: `You can now chat with ${selectedChat.otherUserName}.` });
  };

  const handleDeclineRequest = async () => {
    if (!user || !selectedChat) return;
    if (confirm("Are you sure you want to decline this message request? The conversation will be removed.")) {
      await dmService.removeChat(user.uid, selectedChat.chatId);
      setSelectedChat(null);
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    if (!selectedChat) return;
    try {
      await dmService.deleteMessage(selectedChat.chatId, messageId);
    } catch (error) {
      toast({ variant: "destructive", title: "Failed to delete message" });
    }
  };

  const openNewChatDialog = async () => {
    const users = await userDbService.getAllUsers();
    setAllUsers(users.filter(u => u.uid !== user?.uid));
    setSearchUser('');
    setEmailLookupResult('idle');
    setEmailLookupUser(null);
    setIsNewChatOpen(true);
  };

  // Called whenever the search input changes - auto-lookup if valid email
  const handleSearchChange = (value: string) => {
    setSearchUser(value);
    const normalized = normalizeEmail(value);
    const isEmail = normalized.includes('@') && normalized.includes('.');
    if (!isEmail) {
      setEmailLookupResult('idle');
      setEmailLookupUser(null);
      return;
    }

    if (lookupDebounce.current) clearTimeout(lookupDebounce.current);

    lookupDebounce.current = setTimeout(async () => {
      const requestId = ++latestLookupId.current;
      setEmailLookupResult('loading');

      try {
        const found = await userDbService.getUserByEmail(normalized);
        const isSelf = found && found.uid === user?.uid;
        const exists = !!found && !isSelf;
        // Placeholder: real workspace membership check would go here.
        const workspaceMember = exists;
        const alreadyInvited = user ? inviteService.hasInvited(user.uid, normalized) : false;

        if (requestId !== latestLookupId.current) return; // stale response guard

        if (isSelf) {
          setEmailLookupResult('idle');
          setEmailLookupUser(null);
          return;
        }

        if (exists) {
          setEmailLookupUser(found as UserProfileData);
          setEmailLookupResult(workspaceMember ? 'found_member' : 'found_not_member');
          return;
        }

        setEmailLookupUser(null);
        setEmailLookupResult(alreadyInvited ? 'invited' : 'not_found');
      } catch (error) {
        if (requestId !== latestLookupId.current) return;
        console.error('Lookup failed', error);
        setEmailLookupResult('idle');
      }
    }, 350);
  };

  const handleSendInvite = () => {
    if (!user) return;
    try {
      inviteService.sendInvite({
        senderUid: user.uid,
        senderName: user.name,
        senderEmail: normalizeEmail(user.email || ''),
        recipientEmail: normalizeEmail(searchUser),
        sentAt: Date.now(),
        status: 'sent',
      });
      setEmailLookupResult('invited');
      toast({
        title: 'Invitation Sent',
        description: `An invite to join Infralith has been sent to ${searchUser.trim()}.`,
      });
    } catch (error) {
      console.error('Invite failed', error);
      toast({ variant: 'destructive', title: 'Invite failed', description: 'Could not send the invitation.' });
    }
  };

  const startChatWithUser = async (targetUser: UserProfileData) => {
    const existingChat = chats.find(c => c.otherUserId === targetUser.uid);
    if (existingChat) {
      setSelectedChat(existingChat);
      setIsNewChatOpen(false);
      return;
    }

    const newChatSession: ChatSummary = {
      chatId: dmService.getChatId(user!.uid, targetUser.uid),
      otherUserId: targetUser.uid,
      otherUserName: targetUser.name || targetUser.email || 'Unknown User',
      otherUserAvatar: targetUser.avatar || '',
      lastMessage: '',
      timestamp: Date.now(),
      status: 'accepted',
      unreadCount: 0,
    };
    setChats((prev) => [newChatSession, ...prev.filter((c) => c.chatId !== newChatSession.chatId)]);
    setSelectedChat(newChatSession);
    setMessages([]);
    setIsNewChatOpen(false);
  };

  const isWaitingForAcceptance = user && messages.length > 0 && messages.every(m => m.senderId === user.uid);
  const isIncomingRequest = selectedChat?.status === 'pending';

  const filteredUsers = allUsers.filter(u =>
    (u.name || '').toLowerCase().includes(searchUser.toLowerCase()) ||
    (u.email || '').toLowerCase().includes(searchUser.toLowerCase())
  );

  return (
    <div className="h-[calc(100vh-100px)] grid grid-cols-1 md:grid-cols-[340px_1fr] gap-6 p-6 bg-[#f8f9fc] dark:bg-slate-950">
      {/* Left: Chat List */}
      <Card className={cn("md:col-span-1 flex flex-col overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.04)] border-none rounded-[20px] bg-white dark:bg-slate-900", selectedChat ? "hidden md:flex" : "flex")}>
        <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-white dark:bg-slate-900 z-10">
          <span className="font-bold text-[18px] tracking-tight flex items-center gap-3 text-slate-800 dark:text-slate-100">
            <MessageCircle className="h-5 w-5 text-[#f59e0b]" strokeWidth={2.5} />
            Team Messages
          </span>
          <div className="flex items-center gap-1.5">
            {canCreateGroups && (
              <Dialog open={isGroupDialogActive} onOpenChange={setIsGroupDialogActive}>
                <DialogTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-[#f59e0b]/10 text-[#f59e0b]">
                    <Users className="h-4 w-4" strokeWidth={2.5} />
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create Team Group</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 pt-4">
                    <Input placeholder="Group Name (e.g., Structural Team Alpha)" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
                    <div className="text-sm font-semibold text-muted-foreground">Select Engineers:</div>
                    <ScrollArea className="h-[200px] border rounded-md p-2 bg-muted/30">
                      {allUsers.filter((u: any) => u.role === 'Engineer' || !u.role).map(u => (
                        <label key={u.uid} className="flex items-center gap-3 p-2 hover:bg-muted rounded-md cursor-pointer border border-transparent hover:border-border transition-all">
                          <Checkbox checked={selectedEngineers.includes(u.uid)} onCheckedChange={(c) => {
                            if (c) setSelectedEngineers([...selectedEngineers, u.uid]);
                            else setSelectedEngineers(selectedEngineers.filter(id => id !== u.uid));
                          }} />
                          <Avatar className="h-8 w-8"><AvatarImage src={u.avatar || undefined} /><AvatarFallback>{u.name?.[0]}</AvatarFallback></Avatar>
                          <span className="text-sm font-medium">{u.name}</span>
                        </label>
                      ))}
                      {allUsers.filter((u: any) => u.role === 'Engineer' || !u.role).length === 0 && (
                        <div className="text-center text-sm text-muted-foreground py-10">No engineers found.</div>
                      )}
                    </ScrollArea>
                    <Button className="w-full bg-[#f59e0b] hover:bg-[#d97706] text-white font-bold shadow-lg" onClick={async () => {
                      if (!user) return;
                      const trimmedGroupName = groupName.trim();
                      if (!trimmedGroupName) {
                        toast({ variant: 'destructive', title: 'Group name required' });
                        return;
                      }
                      if (selectedEngineers.length === 0) {
                        toast({ variant: 'destructive', title: 'Select at least one teammate' });
                        return;
                      }
                      await dmService.createGroup(user.uid, user.name, user.avatar || '', trimmedGroupName, selectedEngineers);
                      toast({ title: "Group Created", description: `Added ${selectedEngineers.length} engineers to ${groupName || 'New Group'}` });
                      setIsGroupDialogActive(false);
                      setGroupName('');
                      setSelectedEngineers([]);
                    }}>Create Group Conversation</Button>
                  </div>
                </DialogContent>
              </Dialog>
            )}
            <Dialog open={isNewChatOpen} onOpenChange={setIsNewChatOpen}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="icon" onClick={openNewChatDialog} className="h-8 w-8 hover:bg-[#f59e0b]/10 text-[#f59e0b]">
                  <Plus className="h-4 w-4" strokeWidth={2.5} />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New Workspace Message</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 pt-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input
                      className="w-full pl-9 pr-4 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                      placeholder="Search by name, or type an email address..."
                      value={searchUser}
                      onChange={(e) => handleSearchChange(e.target.value)}
                    />
                  </div>

                  {/* Email lookup result banner */}
                  {searchUser.includes('@') && searchUser.includes('.') && (
                    <div className={`rounded-xl border p-4 flex items-start gap-3 text-sm transition-all ${
                      emailLookupResult === 'found_member'
                        ? 'bg-emerald-500/5 border-emerald-500/20'
                        : emailLookupResult === 'found_not_member'
                          ? 'bg-amber-500/5 border-amber-500/20'
                          : emailLookupResult === 'not_found'
                            ? 'bg-orange-500/5 border-orange-500/20'
                            : emailLookupResult === 'invited'
                              ? 'bg-blue-500/5 border-blue-500/20'
                              : 'bg-muted/40 border-border'
                    }`}>
                      {emailLookupResult === 'loading' && <div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full animate-spin shrink-0" />}
                      {emailLookupResult === 'found_member' && <UserCheck className="h-5 w-5 text-emerald-500 shrink-0" />}
                      {emailLookupResult === 'found_not_member' && <UserPlus className="h-5 w-5 text-amber-500 shrink-0" />}
                      {emailLookupResult === 'not_found' && <UserPlus className="h-5 w-5 text-orange-500 shrink-0" />}
                      {emailLookupResult === 'invited' && <Mail className="h-5 w-5 text-blue-500 shrink-0" />}

                      <div className="flex-1">
                        {emailLookupResult === 'loading' && <p className="text-muted-foreground">Checking registry...</p>}
                        {emailLookupResult === 'found_member' && emailLookupUser && (
                          <>
                            <p className="font-bold text-emerald-700 dark:text-emerald-400">User found on Infralith portal</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{emailLookupUser.name} - {emailLookupUser.email}</p>
                            <button
                              onClick={() => startChatWithUser(emailLookupUser)}
                              className="mt-3 w-full flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg py-2 text-sm font-bold transition-colors"
                            >
                              <MessageCircle className="h-4 w-4" /> Start Conversation
                            </button>
                          </>
                        )}
                        {emailLookupResult === 'found_not_member' && emailLookupUser && (
                          <>
                            <p className="font-bold text-amber-700 dark:text-amber-400">On Infralith, not in this workspace</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{emailLookupUser.name} - {emailLookupUser.email}</p>
                            <button
                              onClick={handleSendInvite}
                              className="mt-3 w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg py-2 text-sm font-bold transition-colors"
                            >
                              <UserPlus className="h-4 w-4" /> Invite to workspace
                            </button>
                          </>
                        )}
                        {emailLookupResult === 'not_found' && (
                          <>
                            <p className="font-bold text-orange-700 dark:text-orange-400">Not registered on Infralith</p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              This email is not in the portal. Send them an app invite to collaborate.
                            </p>
                            <button
                              onClick={handleSendInvite}
                              className="mt-3 w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg py-2 text-sm font-bold transition-colors"
                            >
                              <UserPlus className="h-4 w-4" /> Send Infralith Invite
                            </button>
                          </>
                        )}
                        {emailLookupResult === 'invited' && (
                          <>
                            <p className="font-bold text-blue-700 dark:text-blue-400">Invitation already sent</p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              An invite to {searchUser.trim()} is pending acceptance. You'll be notified when they join.
                            </p>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  <ScrollArea className="h-[260px] border rounded-md">
                    <div className="p-2 space-y-1">
                      {filteredUsers.length === 0 && !searchUser.includes('@') ? (
                        <div className="text-center text-sm text-muted-foreground py-10">
                          <p>No teammates found. Try typing an email address.</p>
                        </div>
                      ) : (
                        filteredUsers.map(u => (
                          <button
                            key={u.uid}
                            onClick={() => startChatWithUser(u)}
                            className="w-full flex items-center gap-3 p-2 rounded-md hover:bg-muted transition-colors text-left"
                          >
                            <Avatar className="h-8 w-8">
                              <AvatarImage src={u.avatar || ''} />
                              <AvatarFallback>{u.name ? u.name[0].toUpperCase() : 'U'}</AvatarFallback>
                            </Avatar>
                            <div className="flex-1 overflow-hidden">
                              <p className="text-sm font-medium">{u.name}</p>
                              <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                            </div>
                            <UserCheck className="h-4 w-4 text-emerald-500 shrink-0" />
                          </button>
                        ))
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2 relative custom-scrollbar bg-white dark:bg-slate-900">
          <div className="absolute top-0 inset-x-0 h-4 bg-gradient-to-b from-white dark:from-slate-900 to-transparent pointer-events-none z-10" />

          {chats.length === 0 ? (
            <div className="text-center text-muted-foreground py-12 px-4 flex flex-col items-center">
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <MessageCircle className="h-6 w-6 text-[#f59e0b] opacity-50" />
              </div>
              <p className="font-medium text-slate-800 dark:text-slate-100">Secure Workspace Chat</p>
              <p className="text-xs mt-1 text-slate-500 dark:text-slate-400">Connect instantly with fellow engineers. Click the + icon to start.</p>
            </div>
          ) : (
            chats.map(chat => (
              <button
                key={chat.chatId}
                onClick={() => setSelectedChat(chat)}
                className={cn(
                  "w-full flex items-start gap-4 p-4 rounded-[16px] transition-colors text-left relative",
                  selectedChat?.chatId === chat.chatId ? "bg-[#fef3c7] dark:bg-amber-900/20" : "hover:bg-slate-50 dark:hover:bg-slate-800 border border-transparent hover:border-slate-100 dark:hover:border-slate-700"
                )}
              >
                <div className="relative shrink-0">
                  <Avatar className="h-11 w-11 border border-black/5 rounded-full shadow-sm bg-slate-100/50">
                    <AvatarImage src={chat.otherUserAvatar} />
                    <AvatarFallback className="text-slate-600 font-bold bg-slate-100">{chat.otherUserName[0]}</AvatarFallback>
                  </Avatar>
                  {chat.status === 'pending' && (
                    <span className="absolute -top-0.5 -right-0.5 h-3 w-3 bg-[#3b82f6] rounded-full border-2 border-white shadow-sm"></span>
                  )}
                </div>
                <div className="flex-1 overflow-hidden pt-0.5">
                  <div className="flex justify-between items-center mb-0.5">
                    <span className="font-bold text-[14px] text-slate-800 dark:text-slate-100 truncate">{chat.otherUserName}</span>
                    <span className="text-[11px] text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap ml-2">
                      {formatDistanceToNow(chat.timestamp, { addSuffix: false }).replace('about ', '')}
                    </span>
                  </div>
                  <div className="flex justify-between items-center mt-1">
                    <p className={cn("text-[13px] truncate pr-2 leading-snug", chat.status === 'pending' ? "font-bold text-slate-800 dark:text-slate-100" : "text-slate-500 dark:text-slate-400")}>
                      {chat.status === 'pending' ? "New Message Request" : (chat.lastMessage || 'Sent an attachment')}
                    </p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {chat.status === 'pending' && <span className="text-[10px] font-black uppercase text-slate-800 dark:text-slate-200">Req</span>}
                      {!!chat.unreadCount && chat.unreadCount > 0 && (
                        <span className="text-[10px] font-black text-white bg-[#f59e0b] rounded-full px-1.5 py-0.5">
                          {chat.unreadCount > 99 ? '99+' : chat.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </Card>

      {/* Right: Chat Window */}
      <Card className={cn("md:col-span-1 flex flex-col overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.04)] border-none rounded-[20px] bg-white dark:bg-slate-900", !selectedChat ? "hidden md:flex" : "flex")}>
        {!selectedChat ? (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-500 bg-white dark:bg-slate-900">
            <div className="h-24 w-24 rounded-3xl bg-[#f59e0b]/5 border border-[#f59e0b]/10 flex items-center justify-center mb-6">
              <ShieldCheck className="h-12 w-12 text-[#f59e0b] opacity-80" />
            </div>
            <h3 className="text-xl font-black text-slate-800 dark:text-slate-100 tracking-tight mb-2">End-to-End Encrypted Team Chat</h3>
            <p className="text-[13px] max-w-[320px] text-center leading-relaxed font-medium">
              Select a conversation or start a new one to communicate securely with your team.
            </p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="px-8 py-5 flex items-center justify-between bg-white dark:bg-slate-900 z-10 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-4">
	                <Button variant="ghost" size="sm" className="md:hidden mr-1 -ml-3" onClick={() => setSelectedChat(null)}>
	                  {'<'}
	                </Button>
                <Avatar className="h-12 w-12 border border-black/5 shadow-sm rounded-full bg-slate-100">
                  <AvatarImage src={selectedChat.otherUserAvatar} />
                  <AvatarFallback className="text-slate-600 font-bold bg-slate-100 text-lg">{selectedChat.otherUserName[0]}</AvatarFallback>
                </Avatar>
                <div className="flex flex-col">
                  <span className="font-bold text-[16px] text-slate-800 dark:text-slate-100">{selectedChat.otherUserName}</span>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="h-1.5 w-1.5 bg-emerald-500 rounded-full"></span>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-widest font-black">Protected Session</span>
                  </div>
                </div>
              </div>

              {canCreateGroups && (
                <Button className="bg-[#1d4ed8] hover:bg-[#1e40af] text-white shadow-md shadow-blue-500/20 h-10 px-5 rounded-full font-bold transition-all gap-2" onClick={() => {
                  if (!user || !selectedChat) return;
                  const meetLink = `${window.location.origin}/meet/room-${Math.floor(Math.random() * 1000000)}`;
	                  dmService.sendMessage(
	                    user.uid,
	                    selectedChat.otherUserId,
	                    selectedChat.otherUserName,
	                    selectedChat.otherUserAvatar,
	                    user.name || user.email || 'Team Member',
	                    user.avatar || '',
	                    `Please join my secure video meeting: ${meetLink}`,
	                    null
	                  );
                  toast({ title: "Meeting Started", description: "Secure video meeting link sent." });
                }}>
                  <Video className="h-4 w-4" /> <span className="hidden sm:inline">Meet</span>
                </Button>
              )}
            </div>

            {/* E2E Privacy Banner */}
            <div className="bg-[#f8f9fa] dark:bg-slate-800/50 py-2.5 px-6 flex items-center justify-center gap-2 border-y border-slate-100 dark:border-slate-700 z-10 relative">
              <ShieldCheck className="h-3.5 w-3.5 text-slate-600 dark:text-slate-300" />
              <span className="text-[10px] text-slate-600 dark:text-slate-400 tracking-[0.1em] font-medium uppercase font-mono">
                <strong className="font-bold uppercase text-slate-800 dark:text-slate-200 mr-1">End-to-End Encrypted:</strong> Messages & files are secured for your privacy.
              </span>
            </div>

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-white dark:bg-slate-900 relative custom-scrollbar" ref={scrollRef}>
              {messages.map((msg, index) => {
                const isMe = msg.senderId === user?.uid;
                const showAvatar = index === messages.length - 1 || messages[index + 1]?.senderId !== msg.senderId;

                return (
                  <div key={msg.id} className={cn("flex group", isMe ? "justify-end" : "justify-start")}>
                    <div className={cn("flex items-end gap-3 max-w-[75%]", isMe ? "flex-row" : "flex-row-reverse")}>
                      {isMe && (
                        <button
                          onClick={() => handleDeleteMessage(msg.id)}
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-red-500 p-1"
                          title="Delete message"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <div className={cn(
                        "flex flex-col shadow-sm rounded-[16px] px-5 py-3 text-[14px] leading-relaxed relative",
                        isMe
                          ? "bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 text-slate-700 dark:text-slate-200"
                          : "bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 text-slate-800 dark:text-slate-100"
                      )}>
                        {msg.imageUrl && (
                          <img src={msg.imageUrl} alt="Shared file" className="max-w-full sm:max-w-[250px] object-cover rounded-[10px] mb-2 mt-1 border border-black/5" />
                        )}
                        {msg.text && (
                          <span className="break-words whitespace-pre-wrap">
                            {msg.text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
                              /(https?:\/\/[^\s]+)/g.test(part) ? (
                                <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-blue-500 dark:text-blue-400 hover:underline inline-flex items-center gap-1 font-bold">
                                  {part}
                                </a>
                              ) : (
                                <span key={i}>{part}</span>
                              )
                            )}
                          </span>
                        )}

                        <div className="text-[9px] text-slate-400 text-right mt-1 w-full relative h-[14px]">
                          <span className={cn("absolute right-0", isMe ? "" : "right-auto left-0")}>
                            {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>

                      {!isMe && (
                        <Avatar className="h-8 w-8 shadow-sm mb-1 bg-slate-100 text-slate-600 font-bold">
                          {showAvatar ? (
                            <>
                              <AvatarImage src={selectedChat.otherUserAvatar} />
                              <AvatarFallback className="bg-slate-100 text-slate-600 font-bold">{selectedChat.otherUserName[0]}</AvatarFallback>
                            </>
                          ) : <div className="h-full w-full bg-transparent" />}
                        </Avatar>
                      )}
                      {isMe && (
                        <Avatar className="h-8 w-8 shadow-sm mb-1 bg-slate-100 text-slate-600 font-bold">
                          {showAvatar ? (
                            <>
                              <AvatarImage src={user?.avatar || ''} />
                              <AvatarFallback className="bg-slate-100 text-slate-600 font-bold">M</AvatarFallback>
                            </>
                          ) : <div className="h-full w-full bg-transparent" />}
                        </Avatar>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {isWaitingForAcceptance && !isIncomingRequest && (
              <div className="px-6 py-4 bg-white dark:bg-slate-900">
                <Alert className="bg-amber-50 border border-amber-100 shadow-sm rounded-xl">
                  <AlertCircle className="h-4 w-4 text-amber-600" />
                  <AlertDescription className="text-xs text-amber-800 ml-2 font-medium">
                    Message sent. The engineer needs to accept your request before replying.
                  </AlertDescription>
                </Alert>
              </div>
            )}

            {isIncomingRequest && (
              <div className="px-6 pb-6 pt-2 bg-white dark:bg-slate-900 z-10">
                <Alert className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-lg rounded-2xl p-5">
                  <div className="flex flex-col gap-4 w-full">
                    <div>
                      <AlertTitle className="font-bold flex items-center gap-2 text-slate-800">
                        <MessageCircle className="h-5 w-5 text-[#f59e0b]" />
                        Workspace Message Request
                      </AlertTitle>
                      <AlertDescription className="text-[13px] text-slate-500 mt-2 font-medium leading-relaxed">
                        <strong className="text-slate-800 mr-1">{selectedChat.otherUserName}</strong>
                        wants to connect and collaborate on the platform. Accepting will allow them to send messages and files.
                      </AlertDescription>
                    </div>
                    <div className="flex gap-3">
                      <Button className="flex-1 shadow-md font-bold bg-[#10b981] hover:bg-[#059669] text-white h-11 rounded-xl" onClick={handleAcceptRequest}>
                        <Check className="mr-2 h-4 w-4" strokeWidth={3} /> Accept
                      </Button>
                      <Button variant="outline" className="flex-1 hover:bg-slate-50 font-bold text-slate-600 border-slate-200 h-11 rounded-xl" onClick={handleDeclineRequest}>
                        <X className="mr-2 h-4 w-4" strokeWidth={3} /> Decline
                      </Button>
                    </div>
                  </div>
                </Alert>
              </div>
            )}

            {/* Input Area */}
            {!isIncomingRequest && (
              <div className="px-6 py-6 border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 relative z-10 w-full flex items-center justify-center">
                {/* Image Attachment Preview */}
                {imagePreview && (
                  <div className="absolute bottom-full left-6 p-4 bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-2xl flex items-center gap-4 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.1)] mb-4 animate-in fade-in slide-in-from-bottom-2 z-20">
                    <div className="relative">
                      <img src={imagePreview} alt="preview" className="h-[72px] w-[72px] object-cover rounded-xl border border-slate-100" />
                      <button onClick={removeSelectedImage} className="absolute -top-2.5 -right-2.5 bg-red-500 text-white rounded-full p-1 shadow-md hover:scale-110 transition-transform hover:bg-red-600">
                        <X className="h-3 w-3" strokeWidth={3} />
                      </button>
                    </div>
                    <span className="text-[13px] text-slate-600 dark:text-slate-300 font-bold tracking-tight">Attachment ready</span>
                  </div>
                )}

                <div className="w-full relative flex items-center border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-full p-1.5 shadow-sm focus-within:ring-2 focus-within:ring-[#f59e0b]/20 focus-within:border-[#f59e0b]/30 transition-all">
                  <label className="h-10 w-10 flex items-center justify-center shrink-0 cursor-pointer text-slate-400 hover:text-[#f59e0b] hover:bg-slate-50 rounded-full transition-all ml-1" title="Attach file">
                    <ImageIcon className="h-5 w-5" />
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleImageSelection}
                    />
                  </label>
                  <input
                    type="text"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                    placeholder="Write a secure message..."
                    className="flex-1 bg-transparent border-none focus:outline-none focus:ring-0 text-[14px] px-3 font-medium placeholder:text-slate-400 dark:placeholder:text-slate-600 text-slate-800 dark:text-slate-100"
                  />
                  <Button
                    className={cn(
                      "h-10 w-10 rounded-full flex items-center justify-center shadow-md transition-all ml-1 shrink-0 bg-white dark:bg-slate-700 border border-slate-100 dark:border-slate-600",
                      (newMessage.trim() || imagePreview) ? "text-[#f59e0b] hover:bg-slate-50" : "text-slate-300 pointer-events-none"
                    )}
                    onClick={handleSendMessage}
                    disabled={!newMessage.trim() && !imagePreview}
                  >
                    <Send className="h-4 w-4 shrink-0 translate-x-[1px]" strokeWidth={2.5} />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}


