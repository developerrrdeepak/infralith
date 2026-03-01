'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Heart,
  MessageCircle,
  Share2,
  MoreHorizontal,
  CheckCircle2,
  Trophy,
  Clock,
  Image as ImageIcon,
  Flame,
  Loader2,
  Send,
} from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { useAppContext } from '@/contexts/app-context';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { postService } from '@/lib/services';

type Post = {
  id: string;
  author: {
    name: string;
    avatar: string;
    role: string;
    verified: boolean;
  };
  content: string;
  image?: string;
  timestamp: string;
  likes: number;
  hasLiked: boolean;
  comments: number;
  shares: number;
  tags: string[];
  isBounty?: boolean;
  bountyAmount?: number;
};

type Comment = {
  id: string;
  authorName: string;
  authorAvatar: string;
  text: string;
  timestamp: number;
};

type CommentThread = {
  comments: Comment[];
  isOpen: boolean;
  isLoading: boolean;
  isSubmitting: boolean;
  newComment: string;
};

const MOCK_POSTS: Post[] = [
  {
    id: '1',
    author: {
      name: 'Apex Engineering Corp',
      avatar: 'https://images.unsplash.com/photo-1560179707-f14e90ef3623?w=100&h=100&auto=format&fit=crop',
      role: 'Enterprise Firm',
      verified: true,
    },
    content: 'Closed the structural analysis for Delta Towers and caught a shear wall weakness early. Saved ~$2.4M in retrofit risk using the compliance agent.',
    image: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&q=80&w=800',
    timestamp: '2 hours ago',
    likes: 342,
    hasLiked: false,
    comments: 45,
    shares: 12,
    tags: ['#StructuralEngineering', '#InfralithSuccess', '#AIinConstruction'],
  },
  {
    id: '2',
    author: {
      name: 'Elena Rodriguez',
      avatar: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=100&h=100&auto=format&fit=crop',
      role: 'Lead Site Engineer',
      verified: true,
    },
    content: 'Wrapped Phase 3 concrete pour. Risk aggregator stayed at 98% safety confidence throughout the window. Great coordination from the field team.',
    timestamp: '5 hours ago',
    likes: 128,
    hasLiked: false,
    comments: 18,
    shares: 3,
    tags: ['#WomenInSTEM', '#SiteUpdates', '#SafetyFirst'],
  },
  {
    id: '3',
    author: {
      name: 'Titan Constructors',
      avatar: 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=100&h=100&auto=format&fit=crop',
      role: 'Global Contractor',
      verified: true,
    },
    content: 'Expanding the drone fleet for automated site surveying. New blueprint API integration is giving us real-time structural deltas—telemetry report coming next week.',
    image: 'https://images.unsplash.com/photo-1508614589041-895b88991e3e?auto=format&fit=crop&q=80&w=800',
    timestamp: '1 day ago',
    likes: 567,
    hasLiked: true,
    comments: 89,
    shares: 44,
    tags: ['#DroneTech', '#Innovation', '#ConstructionTech'],
  },
  {
    id: '4',
    author: {
      name: 'Anonymous (Code Solvers Bounty)',
      avatar: 'https://api.dicebear.com/7.x/shapes/svg?seed=bounty',
      role: 'Seeking Structural Insight',
      verified: false,
    },
    content: 'BOUNTY: Repeated 4A-Seismic compliance failures on staggered truss systems above 40 floors. AI flags shear wall connections as inadequate. Need alternative detailing that meets ISO 19902. $5,000 for a verified solution.',
    timestamp: '15 mins ago',
    likes: 12,
    hasLiked: false,
    comments: 4,
    shares: 8,
    tags: ['#Bounty', '#SeismicDesign', '#TrussSystem'],
    isBounty: true,
    bountyAmount: 5000,
  },
];

const DEFAULT_THREAD: CommentThread = { comments: [], isOpen: false, isLoading: false, isSubmitting: false, newComment: '' };

export default function CommunityPage() {
  const { user } = useAppContext();
  const { toast } = useToast();

  const [posts, setPosts] = useState<Post[]>([]);
  const [following, setFollowing] = useState<Record<string, boolean>>({});
  const [newPostContent, setNewPostContent] = useState('');
  const [newPostImage, setNewPostImage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isPublishing, setIsPublishing] = useState(false);
  const [commentThreads, setCommentThreads] = useState<Record<string, CommentThread>>({});

  const followingKey = useMemo(() => (user?.uid ? `infralith_following_${user.uid}` : null), [user?.uid]);

  useEffect(() => {
    if (!followingKey) return;
    const stored = localStorage.getItem(followingKey);
    setFollowing(stored ? JSON.parse(stored) : {});
  }, [followingKey]);

  const persistFollowing = (next: Record<string, boolean>) => {
    if (followingKey) {
      localStorage.setItem(followingKey, JSON.stringify(next));
    }
  };

  const formatRelativeTime = (timestamp: number | string) => {
    if (typeof timestamp === 'string') return timestamp;
    const diff = Date.now() - timestamp;
    if (diff < 60_000) return 'Just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    const days = Math.floor(diff / 86_400_000);
    return `${days}d ago`;
  };

  useEffect(() => {
    const loadPosts = async () => {
      setIsLoading(true);
      try {
        const data = await postService.getAllPosts();
        if (data.length === 0) {
          setPosts(MOCK_POSTS);
        } else {
          setPosts(
            data.map((p: any) => ({
              id: p.id,
              author: {
                name: p.authorName,
                avatar: p.authorAvatar,
                role: 'Engineer',
                verified: true,
              },
              content: p.content,
              image: p.image || undefined,
              timestamp: formatRelativeTime(p.timestamp),
              likes: p.likeCount || 0,
              hasLiked: !!(p.likes && p.likes[user?.uid || '']),
              comments: p.commentCount || 0,
              shares: p.shares || 0,
              tags: ['#CommunityUpdate'],
            })),
          );
        }
      } catch (error) {
        console.error('Failed to load posts', error);
        toast({ variant: 'destructive', title: 'Could not load community feed' });
        setPosts(MOCK_POSTS);
      } finally {
        setIsLoading(false);
      }
    };
    loadPosts();
  }, [user?.uid, toast]);

  const toggleLike = async (postId: string) => {
    if (!user?.uid) {
      toast({ variant: 'destructive', title: 'Login required', description: 'Sign in to like posts.' });
      return;
    }
    await postService.toggleLike(postId, user.uid);
    setPosts((prev) =>
      prev.map((post) => {
        if (post.id === postId) {
          const isLiking = !post.hasLiked;
          return {
            ...post,
            hasLiked: isLiking,
            likes: isLiking ? post.likes + 1 : Math.max(0, post.likes - 1),
          };
        }
        return post;
      }),
    );
  };

  const toggleFollow = (authorName: string) => {
    setFollowing((prev) => {
      const isFollowing = !prev[authorName];
      const next = { ...prev, [authorName]: isFollowing };
      persistFollowing(next);
      toast({
        title: isFollowing ? `Following ${authorName}` : `Unfollowed ${authorName}`,
        description: isFollowing ? 'You will now see their updates in your feed.' : 'You will no longer see their updates.',
      });
      return next;
    });
  };

  const handlePostSubmit = async () => {
    if (!newPostContent.trim() || !user) return;
    setIsPublishing(true);
    try {
      const authorName = user.name || user.email || 'Anonymous Engineer';

      const postId = await postService.createPost(
        user.uid,
        authorName,
        user.avatar || '',
        user.email,
        newPostContent,
        newPostImage.trim() || null,
      );

      const newPost: Post = {
        id: postId,
        author: {
          name: authorName,
          avatar: user.avatar || '',
          role: user?.role || 'Engineer',
          verified: false,
        },
        content: newPostContent,
        image: newPostImage.trim() || undefined,
        timestamp: 'Just now',
        likes: 0,
        hasLiked: false,
        comments: 0,
        shares: 0,
        tags: ['#CommunityUpdate'],
      };

      setPosts((prev) => [newPost, ...prev]);
      setNewPostContent('');
      setNewPostImage('');
      toast({
        title: 'Post published',
        description: 'Your update has been shared with the community.',
      });
    } catch (error) {
      console.error('Failed to publish post', error);
      toast({ variant: 'destructive', title: 'Could not publish post' });
    } finally {
      setIsPublishing(false);
    }
  };

  const toggleComments = async (postId: string) => {
    let shouldFetch = false;
    setCommentThreads((prev) => {
      const current = prev[postId] || DEFAULT_THREAD;
      const isOpening = !current.isOpen;
      if (isOpening && current.comments.length === 0) shouldFetch = true;
      return {
        ...prev,
        [postId]: { ...current, isOpen: isOpening, isLoading: isOpening && current.comments.length === 0 },
      };
    });

    if (shouldFetch) {
      try {
        const comments = await postService.getComments(postId);
        setCommentThreads((prev) => ({
          ...prev,
          [postId]: { ...(prev[postId] || DEFAULT_THREAD), comments, isLoading: false, isOpen: true },
        }));
      } catch (error) {
        console.error('Failed to load comments', error);
        toast({ variant: 'destructive', title: 'Could not load comments' });
        setCommentThreads((prev) => ({
          ...prev,
          [postId]: { ...(prev[postId] || DEFAULT_THREAD), isLoading: false, isOpen: true },
        }));
      }
    }
  };

  const handleCommentSubmit = async (postId: string) => {
    if (!user?.uid) {
      toast({ variant: 'destructive', title: 'Login required', description: 'Sign in to comment.' });
      return;
    }
    const thread = commentThreads[postId] || DEFAULT_THREAD;
    if (!thread.newComment.trim()) return;

    setCommentThreads((prev) => ({
      ...prev,
      [postId]: { ...thread, isSubmitting: true },
    }));

    try {
      const commentId = await postService.addComment(
        postId,
        user.uid,
        user.name || user.email || 'Engineer',
        user.avatar || '',
        thread.newComment.trim(),
      );
      const newComment: Comment = {
        id: commentId,
        authorName: user.name || user.email || 'Engineer',
        authorAvatar: user.avatar || '',
        text: thread.newComment.trim(),
        timestamp: Date.now(),
      };
      setCommentThreads((prev) => ({
        ...prev,
        [postId]: { ...DEFAULT_THREAD, comments: [...(prev[postId]?.comments || []), newComment], isOpen: true },
      }));
      setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, comments: p.comments + 1 } : p)));
    } catch (error) {
      console.error('Failed to add comment', error);
      toast({ variant: 'destructive', title: 'Could not post comment' });
      setCommentThreads((prev) => ({
        ...prev,
        [postId]: { ...(prev[postId] || thread), isSubmitting: false },
      }));
    }
  };

  const handleShare = async (post: Post) => {
    const shareText = `${post.author.name} on Infralith:\n\n${post.content}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Infralith Community', text: shareText });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(shareText);
      }
      toast({ title: 'Link copied', description: 'Share this update with your team.' });
    } catch (error) {
      console.error('Share failed', error);
      toast({ variant: 'destructive', title: 'Share failed' });
    }
  };

  const renderLoading = () => (
    <div className="space-y-4">
      {[...Array(3)].map((_, i) => (
        <Card key={i} className="premium-glass p-4">
          <div className="flex items-center gap-3 mb-3">
            <Skeleton className="h-12 w-12 rounded-full" />
            <div className="space-y-2 flex-1">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-2/3" />
        </Card>
      ))}
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-12">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary/20 flex items-center justify-center">
            <Trophy className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-3xl font-black tracking-tight">Global Community</h1>
        </div>
        <p className="text-muted-foreground font-mono text-sm tracking-widest">Real-world engineering updates, shared safely.</p>
      </div>

      <Card className="premium-glass p-1 shadow-lg">
        <CardContent className="p-4 flex gap-4">
          <Avatar className="h-12 w-12 border border-primary/20">
            <AvatarImage src={user?.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.email}`} />
            <AvatarFallback>{user?.name?.charAt(0) || 'U'}</AvatarFallback>
          </Avatar>
          <div className="flex-1 space-y-3">
            <Input
              placeholder="Share a project update with the community..."
              className="bg-slate-50 dark:bg-black/60 border-slate-200 dark:border-white/10 text-slate-900 dark:text-white text-sm py-6 rounded-xl focus-visible:ring-primary/50 shadow-inner transition-colors"
              value={newPostContent}
              onChange={(e) => setNewPostContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handlePostSubmit();
                }
              }}
            />
            <Input
              placeholder="Optional image URL (https://...)"
              className="bg-slate-50 dark:bg-black/60 border-slate-200 dark:border-white/10 text-slate-900 dark:text-white text-sm py-6 rounded-xl focus-visible:ring-primary/50 shadow-inner transition-colors"
              value={newPostImage}
              onChange={(e) => setNewPostImage(e.target.value)}
            />
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-primary transition-colors">
                <ImageIcon className="h-4 w-4 mr-2" /> Add image link
              </Button>
              <Button
                size="sm"
                className="bg-primary text-background-dark font-bold px-6 rounded-lg shadow-lg shadow-primary/20"
                onClick={handlePostSubmit}
                disabled={isPublishing || !newPostContent.trim()}
              >
                {isPublishing ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Publish'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-6">
        {isLoading ? (
          renderLoading()
        ) : posts.length === 0 ? (
          <Card className="premium-glass p-6 text-center">
            <p className="text-muted-foreground">No posts yet. Share the first update with the network.</p>
          </Card>
        ) : (
          posts.map((post) => (
            <Card key={post.id} className="premium-glass premium-glass-hover overflow-hidden transition-all duration-300">
              <CardHeader className="flex flex-row items-center justify-between p-5 pb-3">
                <div className="flex items-center gap-4">
                  <Avatar className="h-12 w-12 border border-primary/30 shadow-sm">
                    <AvatarImage src={post.author.avatar} />
                    <AvatarFallback>{post.author.name.charAt(0)}</AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5">
                      <h3 className="text-sm font-bold text-foreground">{post.author.name}</h3>
                      {post.author.verified && <CheckCircle2 className="h-3.5 w-3.5 text-blue-400" />}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-primary/80">{post.author.role}</span>
                      <span>•</span>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" /> {post.timestamp}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {post.isBounty && (
                    <Badge variant="outline" className="text-xs bg-orange-500/10 text-orange-500 border-orange-500/30 flex items-center gap-1">
                      <Flame className="h-3 w-3" /> ${post.bountyAmount?.toLocaleString()} Bounty
                    </Badge>
                  )}
                  {(user?.name || user?.email || 'Anonymous Engineer') !== post.author.name && !post.isBounty && (
                    <Button
                      variant={following[post.author.name] ? 'outline' : 'default'}
                      size="sm"
                      className={cn('h-8 px-4 text-xs font-bold transition-all', following[post.author.name] ? '' : 'bg-primary text-background-dark')}
                      onClick={() => toggleFollow(post.author.name)}
                    >
                      {following[post.author.name] ? 'Following' : 'Follow'}
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground shrink-0">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>

              <CardContent className="p-0">
                <div className="px-5 pb-3">
                  <p className="text-sm text-foreground/90 leading-relaxed font-medium">{post.content}</p>
                  <div className="flex flex-wrap gap-2 mt-3">
                    {post.tags.map((tag, i) => (
                      <span key={i} className="text-xs font-bold text-primary cursor-pointer hover:underline">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>

                {post.image && (
                  <div className="w-full max-h-[400px] overflow-hidden bg-black/20 border-y border-white/5">
                    <img src={post.image} alt="Post attachment" className="w-full h-full object-cover transition-transform hover:scale-105 duration-700" loading="lazy" />
                  </div>
                )}

                <div className="flex items-center justify-between p-3 px-5 bg-slate-50 dark:bg-black/20 backdrop-blur-sm border-t border-slate-100 dark:border-white/5 transition-colors">
                  <div className="flex items-center gap-6">
                    <button
                      onClick={() => toggleLike(post.id)}
                      className={cn(
                        'flex items-center gap-2 text-sm font-semibold transition-all group',
                        post.hasLiked ? 'text-red-500' : 'text-muted-foreground hover:text-red-500',
                      )}
                    >
                      <Heart className={cn('h-5 w-5 transition-transform group-active:scale-75', post.hasLiked ? 'fill-current' : '')} />
                      <span>{post.likes}</span>
                    </button>

                    <button
                      className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-primary transition-all group"
                      onClick={() => toggleComments(post.id)}
                    >
                      <MessageCircle className="h-5 w-5 transition-transform group-active:scale-75" />
                      <span>{post.comments}</span>
                    </button>

                    <button
                      className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-primary transition-all group"
                      onClick={() => handleShare(post)}
                    >
                      <Share2 className="h-5 w-5 transition-transform group-active:scale-75" />
                      <span>{post.shares}</span>
                    </button>
                  </div>

                  <Badge variant="outline" className="text-[10px] uppercase font-bold tracking-widest border-primary/20 bg-primary/5 text-primary">
                    Network Verified
                  </Badge>
                </div>

                {commentThreads[post.id]?.isOpen && (
                  <div className="border-t border-slate-100 dark:border-white/5 bg-slate-50/50 dark:bg-black/10 p-4 space-y-3">
                    {commentThreads[post.id]?.isLoading ? (
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-1/2" />
                        <Skeleton className="h-4 w-3/4" />
                      </div>
                    ) : (
                      <div className="space-y-3 max-h-48 overflow-y-auto pr-1">
                        {commentThreads[post.id]?.comments?.length ? (
                          commentThreads[post.id].comments.map((comment) => (
                            <div key={comment.id} className="flex gap-3">
                              <Avatar className="h-8 w-8 border border-primary/20">
                                <AvatarImage src={comment.authorAvatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${comment.authorName}`} />
                                <AvatarFallback>{comment.authorName.charAt(0)}</AvatarFallback>
                              </Avatar>
                              <div className="flex-1">
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                  <span className="font-semibold text-foreground">{comment.authorName}</span>
                                  <span>•</span>
                                  <span>{formatRelativeTime(comment.timestamp)}</span>
                                </div>
                                <p className="text-sm text-foreground/90">{comment.text}</p>
                              </div>
                            </div>
                          ))
                        ) : (
                          <p className="text-sm text-muted-foreground">No comments yet. Start the conversation.</p>
                        )}
                      </div>
                    )}

                    <div className="flex items-start gap-2">
                      <Textarea
                        placeholder="Add a constructive comment"
                        value={commentThreads[post.id]?.newComment || ''}
                        onChange={(e) =>
                          setCommentThreads((prev) => ({
                            ...prev,
                            [post.id]: { ...(prev[post.id] || DEFAULT_THREAD), isOpen: true, newComment: e.target.value },
                          }))
                        }
                        className="text-sm bg-white dark:bg-black/50 border-slate-200 dark:border-white/10"
                      />
                      <Button
                        size="icon"
                        disabled={commentThreads[post.id]?.isSubmitting || !(commentThreads[post.id]?.newComment || '').trim()}
                        onClick={() => handleCommentSubmit(post.id)}
                      >
                        {commentThreads[post.id]?.isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
