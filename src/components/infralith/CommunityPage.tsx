'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Flame,
  Heart,
  Image as ImageIcon,
  Loader2,
  MessageCircle,
  Search,
  Send,
  Share2,
  Trash2,
  Trophy,
  UserPlus,
  Users,
} from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useAppContext } from '@/contexts/app-context';
import { useToast } from '@/hooks/use-toast';
import { postService, type Post as ServicePost, type Comment as ServiceComment } from '@/lib/services';

type FeedMode = 'all' | 'following' | 'bounties' | 'mine';
type SortMode = 'latest' | 'popular' | 'discussed';

type Post = {
  id: string;
  authorId: string;
  author: {
    name: string;
    avatar: string;
    role: string;
    verified: boolean;
  };
  content: string;
  image?: string;
  timestamp: number;
  likes: number;
  hasLiked: boolean;
  comments: number;
  shares: number;
  tags: string[];
  isBounty?: boolean;
  bountyAmount?: number;
};

type CommentThread = {
  comments: ServiceComment[];
  isOpen: boolean;
  isLoading: boolean;
  isSubmitting: boolean;
  newComment: string;
};

const createDefaultThread = (): CommentThread => ({
  comments: [],
  isOpen: false,
  isLoading: false,
  isSubmitting: false,
  newComment: '',
});

const ONE_MINUTE = 60_000;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;

const MOCK_POSTS: Post[] = [
  {
    id: 'seed_post_1',
    authorId: 'seed_apex',
    author: {
      name: 'Apex Engineering Corp',
      avatar: 'https://images.unsplash.com/photo-1560179707-f14e90ef3623?w=100&h=100&auto=format&fit=crop',
      role: 'Enterprise Firm',
      verified: true,
    },
    content:
      'Closed the structural analysis for Delta Towers and caught a shear wall weakness early. Saved ~$2.4M in retrofit risk using the compliance agent.',
    image: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&q=80&w=1000',
    timestamp: Date.now() - 2 * ONE_HOUR,
    likes: 342,
    hasLiked: false,
    comments: 45,
    shares: 12,
    tags: ['#StructuralEngineering', '#InfralithSuccess', '#AIinConstruction'],
  },
  {
    id: 'seed_post_2',
    authorId: 'seed_elena',
    author: {
      name: 'Elena Rodriguez',
      avatar: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=100&h=100&auto=format&fit=crop',
      role: 'Lead Site Engineer',
      verified: true,
    },
    content:
      'Wrapped Phase 3 concrete pour. Risk aggregator stayed at 98% safety confidence throughout the window. Great coordination from the field team.',
    timestamp: Date.now() - 5 * ONE_HOUR,
    likes: 128,
    hasLiked: false,
    comments: 18,
    shares: 3,
    tags: ['#WomenInSTEM', '#SiteUpdates', '#SafetyFirst'],
  },
  {
    id: 'seed_post_3',
    authorId: 'seed_titan',
    author: {
      name: 'Titan Constructors',
      avatar: 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=100&h=100&auto=format&fit=crop',
      role: 'Global Contractor',
      verified: true,
    },
    content:
      'Expanding the drone fleet for automated site surveying. New blueprint API integration is giving us real-time structural deltas. Telemetry report coming next week.',
    image: 'https://images.unsplash.com/photo-1508614589041-895b88991e3e?auto=format&fit=crop&q=80&w=1000',
    timestamp: Date.now() - ONE_DAY,
    likes: 567,
    hasLiked: false,
    comments: 89,
    shares: 44,
    tags: ['#DroneTech', '#Innovation', '#ConstructionTech'],
  },
  {
    id: 'seed_post_4',
    authorId: 'seed_bounty',
    author: {
      name: 'Anonymous (Code Solvers Bounty)',
      avatar: 'https://api.dicebear.com/7.x/shapes/svg?seed=bounty',
      role: 'Seeking Structural Insight',
      verified: false,
    },
    content:
      'BOUNTY: Repeated 4A-Seismic compliance failures on staggered truss systems above 40 floors. Need alternative detailing that meets ISO 19902. Reward for a verified solution.',
    timestamp: Date.now() - 20 * ONE_MINUTE,
    likes: 12,
    hasLiked: false,
    comments: 4,
    shares: 8,
    tags: ['#Bounty', '#SeismicDesign', '#TrussSystem'],
    isBounty: true,
    bountyAmount: 5000,
  },
];

const FOLLOWING_KEY_PREFIX = 'infralith_following_';

const isValidHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const formatRelativeTime = (timestamp: number) => {
  const diff = Date.now() - timestamp;
  if (diff < ONE_MINUTE) return 'Just now';
  if (diff < ONE_HOUR) return `${Math.floor(diff / ONE_MINUTE)} min ago`;
  if (diff < ONE_DAY) return `${Math.floor(diff / ONE_HOUR)}h ago`;
  return `${Math.floor(diff / ONE_DAY)}d ago`;
};

const parseTags = (raw: string) => {
  const entries = raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`));
  return [...new Set(entries)].slice(0, 8);
};

const toPostView = (raw: Partial<ServicePost> & { id: string; authorName: string; content: string }, userId?: string): Post => {
  const timestamp = typeof raw.timestamp === 'number' ? raw.timestamp : Date.now();
  const likes = raw.likes || {};
  return {
    id: raw.id,
    authorId: raw.authorId || 'unknown-author',
    author: {
      name: raw.authorName,
      avatar: raw.authorAvatar || '',
      role: raw.authorRole || 'Engineer',
      verified: raw.verified ?? true,
    },
    content: raw.content,
    image: raw.image || undefined,
    timestamp,
    likes: typeof raw.likeCount === 'number' ? raw.likeCount : 0,
    hasLiked: !!(userId && likes[userId]),
    comments: typeof raw.commentCount === 'number' ? raw.commentCount : 0,
    shares: typeof raw.shares === 'number' ? raw.shares : 0,
    tags: Array.isArray(raw.tags) && raw.tags.length > 0 ? raw.tags : ['#CommunityUpdate'],
    isBounty: !!raw.isBounty,
    bountyAmount: raw.isBounty ? raw.bountyAmount : undefined,
  };
};

export default function CommunityPage() {
  const { user } = useAppContext();
  const { toast } = useToast();

  const [posts, setPosts] = useState<Post[]>([]);
  const [following, setFollowing] = useState<Record<string, boolean>>({});
  const [commentThreads, setCommentThreads] = useState<Record<string, CommentThread>>({});

  const [isLoading, setIsLoading] = useState(true);
  const [isPublishing, setIsPublishing] = useState(false);

  const [searchText, setSearchText] = useState('');
  const [feedMode, setFeedMode] = useState<FeedMode>('all');
  const [sortMode, setSortMode] = useState<SortMode>('latest');

  const [newPostContent, setNewPostContent] = useState('');
  const [newPostImage, setNewPostImage] = useState('');
  const [newPostTags, setNewPostTags] = useState('');
  const [isBountyDraft, setIsBountyDraft] = useState(false);
  const [newBountyAmount, setNewBountyAmount] = useState('5000');

  const followingKey = useMemo(() => {
    return user?.uid ? `${FOLLOWING_KEY_PREFIX}${user.uid}` : null;
  }, [user?.uid]);

  useEffect(() => {
    if (!followingKey) {
      setFollowing({});
      return;
    }

    try {
      const raw = localStorage.getItem(followingKey);
      setFollowing(raw ? (JSON.parse(raw) as Record<string, boolean>) : {});
    } catch {
      setFollowing({});
    }
  }, [followingKey]);

  const persistFollowing = (next: Record<string, boolean>) => {
    if (!followingKey) return;
    localStorage.setItem(followingKey, JSON.stringify(next));
  };

  useEffect(() => {
    let cancelled = false;

    const loadPosts = async () => {
      setIsLoading(true);
      try {
        let data = await postService.getAllPosts();

        if (data.length === 0) {
          data = await postService.seedPosts(
            MOCK_POSTS.map((post) => ({
              id: post.id,
              authorId: post.authorId,
              authorName: post.author.name,
              authorAvatar: post.author.avatar,
              authorRole: post.author.role,
              verified: post.author.verified,
              authorHandle: post.author.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20),
              content: post.content,
              image: post.image,
              timestamp: post.timestamp,
              likes: {},
              likeCount: post.likes,
              commentCount: post.comments,
              shares: post.shares,
              tags: post.tags,
              isBounty: post.isBounty,
              bountyAmount: post.bountyAmount,
            }))
          );
        }

        if (!cancelled) {
          setPosts(data.map((item) => toPostView(item, user?.uid)));
        }
      } catch (error) {
        console.error('Failed to load community feed', error);
        if (!cancelled) {
          setPosts(MOCK_POSTS.map((post) => ({ ...post, hasLiked: false })));
          toast({ variant: 'destructive', title: 'Could not load community feed' });
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    loadPosts();
    return () => {
      cancelled = true;
    };
  }, [toast, user?.uid]);

  const feedCounts = useMemo(() => {
    const followingPosts = posts.filter((post) => !!following[post.author.name]).length;
    const bountyPosts = posts.filter((post) => post.isBounty).length;
    const myPosts = posts.filter((post) => post.authorId === user?.uid).length;
    return {
      all: posts.length,
      following: followingPosts,
      bounties: bountyPosts,
      mine: myPosts,
    };
  }, [posts, following, user?.uid]);

  const visiblePosts = useMemo(() => {
    let result = [...posts];

    if (feedMode === 'following') {
      result = result.filter((post) => !!following[post.author.name]);
    }
    if (feedMode === 'bounties') {
      result = result.filter((post) => !!post.isBounty);
    }
    if (feedMode === 'mine') {
      result = result.filter((post) => post.authorId === user?.uid);
    }

    const query = searchText.trim().toLowerCase();
    if (query) {
      result = result.filter((post) => {
        const inTags = post.tags.some((tag) => tag.toLowerCase().includes(query));
        return (
          post.author.name.toLowerCase().includes(query) ||
          post.content.toLowerCase().includes(query) ||
          inTags
        );
      });
    }

    if (sortMode === 'popular') {
      result.sort((a, b) => b.likes + b.shares * 2 - (a.likes + a.shares * 2));
    } else if (sortMode === 'discussed') {
      result.sort((a, b) => b.comments - a.comments || b.timestamp - a.timestamp);
    } else {
      result.sort((a, b) => b.timestamp - a.timestamp);
    }

    return result;
  }, [posts, feedMode, following, searchText, sortMode, user?.uid]);

  const toggleFollow = (authorName: string) => {
    if (!followingKey) {
      toast({ variant: 'destructive', title: 'Login required', description: 'Sign in to follow members.' });
      return;
    }

    setFollowing((prev) => {
      const isFollowing = !prev[authorName];
      const next = { ...prev, [authorName]: isFollowing };
      persistFollowing(next);
      toast({
        title: isFollowing ? `Following ${authorName}` : `Unfollowed ${authorName}`,
        description: isFollowing
          ? 'You will now see this member in your Following feed.'
          : 'This member has been removed from your Following feed.',
      });
      return next;
    });
  };

  const handlePostSubmit = async () => {
    if (!user?.uid) {
      toast({ variant: 'destructive', title: 'Login required', description: 'Sign in to publish updates.' });
      return;
    }

    const content = newPostContent.trim();
    const image = newPostImage.trim();
    const tags = parseTags(newPostTags);

    if (!content) return;
    if (image && !isValidHttpUrl(image)) {
      toast({ variant: 'destructive', title: 'Invalid image URL', description: 'Image URL must start with http:// or https://.' });
      return;
    }

    let bountyAmount: number | undefined;
    if (isBountyDraft) {
      const parsedBounty = Number(newBountyAmount);
      if (!Number.isFinite(parsedBounty) || parsedBounty <= 0) {
        toast({ variant: 'destructive', title: 'Invalid bounty amount', description: 'Enter a positive bounty amount.' });
        return;
      }
      bountyAmount = Math.round(parsedBounty);
    }

    setIsPublishing(true);
    try {
      const authorName = user.name || user.email || 'Anonymous Engineer';
      const postId = await postService.createPost(
        user.uid,
        authorName,
        user.avatar || '',
        user.email || '',
        content,
        image || null,
        {
          tags: tags.length > 0 ? tags : ['#CommunityUpdate'],
          isBounty: isBountyDraft,
          bountyAmount,
          authorRole: user.role || 'Engineer',
          verified: false,
        }
      );

      const newPost: Post = {
        id: postId,
        authorId: user.uid,
        author: {
          name: authorName,
          avatar: user.avatar || '',
          role: user.role || 'Engineer',
          verified: false,
        },
        content,
        image: image || undefined,
        timestamp: Date.now(),
        likes: 0,
        hasLiked: false,
        comments: 0,
        shares: 0,
        tags: tags.length > 0 ? tags : ['#CommunityUpdate'],
        isBounty: isBountyDraft,
        bountyAmount,
      };

      setPosts((prev) => [newPost, ...prev]);
      setNewPostContent('');
      setNewPostImage('');
      setNewPostTags('');
      setIsBountyDraft(false);
      setNewBountyAmount('5000');
      toast({ title: 'Post published', description: 'Your update is now live in Global Community.' });
    } catch (error) {
      console.error('Failed to publish post', error);
      toast({ variant: 'destructive', title: 'Could not publish post' });
    } finally {
      setIsPublishing(false);
    }
  };

  const handleToggleLike = async (postId: string) => {
    if (!user?.uid) {
      toast({ variant: 'destructive', title: 'Login required', description: 'Sign in to like posts.' });
      return;
    }

    try {
      await postService.toggleLike(postId, user.uid);
      setPosts((prev) =>
        prev.map((post) => {
          if (post.id !== postId) return post;
          const nextLiked = !post.hasLiked;
          return {
            ...post,
            hasLiked: nextLiked,
            likes: nextLiked ? post.likes + 1 : Math.max(0, post.likes - 1),
          };
        })
      );
    } catch (error) {
      console.error('Failed to toggle like', error);
      toast({ variant: 'destructive', title: 'Could not update like' });
    }
  };

  const toggleComments = async (postId: string) => {
    let shouldFetch = false;

    setCommentThreads((prev) => {
      const current = prev[postId] || createDefaultThread();
      const opening = !current.isOpen;
      shouldFetch = opening && current.comments.length === 0;
      return {
        ...prev,
        [postId]: {
          ...current,
          isOpen: opening,
          isLoading: shouldFetch,
        },
      };
    });

    if (!shouldFetch) return;

    try {
      const comments = await postService.getComments(postId);
      setCommentThreads((prev) => ({
        ...prev,
        [postId]: {
          ...(prev[postId] || createDefaultThread()),
          comments,
          isOpen: true,
          isLoading: false,
        },
      }));
    } catch (error) {
      console.error('Failed to load comments', error);
      toast({ variant: 'destructive', title: 'Could not load comments' });
      setCommentThreads((prev) => ({
        ...prev,
        [postId]: {
          ...(prev[postId] || createDefaultThread()),
          isOpen: true,
          isLoading: false,
        },
      }));
    }
  };

  const handleCommentSubmit = async (postId: string) => {
    if (!user?.uid) {
      toast({ variant: 'destructive', title: 'Login required', description: 'Sign in to comment.' });
      return;
    }

    const draft = (commentThreads[postId]?.newComment || '').trim();
    if (!draft) return;

    setCommentThreads((prev) => ({
      ...prev,
      [postId]: {
        ...(prev[postId] || createDefaultThread()),
        isSubmitting: true,
      },
    }));

    try {
      const commentId = await postService.addComment(
        postId,
        user.uid,
        user.name || user.email || 'Engineer',
        user.avatar || '',
        draft
      );

      const comment: ServiceComment = {
        id: commentId,
        authorId: user.uid,
        authorName: user.name || user.email || 'Engineer',
        authorAvatar: user.avatar || '',
        text: draft,
        timestamp: Date.now(),
      };

      setCommentThreads((prev) => {
        const thread = prev[postId] || createDefaultThread();
        return {
          ...prev,
          [postId]: {
            ...thread,
            comments: [...thread.comments, comment],
            isOpen: true,
            isLoading: false,
            isSubmitting: false,
            newComment: '',
          },
        };
      });

      setPosts((prev) => prev.map((post) => (post.id === postId ? { ...post, comments: post.comments + 1 } : post)));
    } catch (error) {
      console.error('Failed to post comment', error);
      toast({ variant: 'destructive', title: 'Could not post comment' });
      setCommentThreads((prev) => ({
        ...prev,
        [postId]: {
          ...(prev[postId] || createDefaultThread()),
          isSubmitting: false,
        },
      }));
    }
  };

  const handleShare = async (post: Post) => {
    const shareText = `${post.author.name} on Infralith Global Community:\n\n${post.content}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Infralith Community', text: shareText });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(shareText);
      } else {
        throw new Error('No share support');
      }

      await postService.incrementShare(post.id);
      setPosts((prev) => prev.map((item) => (item.id === post.id ? { ...item, shares: item.shares + 1 } : item)));
      toast({ title: 'Shared', description: 'Post copied/shared successfully.' });
    } catch (error: any) {
      if (error?.name === 'AbortError') return;
      console.error('Share failed', error);
      toast({ variant: 'destructive', title: 'Share failed' });
    }
  };

  const handleDeletePost = async (post: Post) => {
    if (!user?.uid || post.authorId !== user.uid) return;

    const confirmed = window.confirm('Delete this post permanently?');
    if (!confirmed) return;

    try {
      await postService.deletePost(post.id);
      setPosts((prev) => prev.filter((item) => item.id !== post.id));
      setCommentThreads((prev) => {
        const next = { ...prev };
        delete next[post.id];
        return next;
      });
      toast({ title: 'Post deleted' });
    } catch (error) {
      console.error('Failed to delete post', error);
      toast({ variant: 'destructive', title: 'Could not delete post' });
    }
  };

  const feedOptions: Array<{ key: FeedMode; label: string; count: number }> = [
    { key: 'all', label: 'All', count: feedCounts.all },
    { key: 'following', label: 'Following', count: feedCounts.following },
    { key: 'bounties', label: 'Bounties', count: feedCounts.bounties },
    { key: 'mine', label: 'My Posts', count: feedCounts.mine },
  ];

  const renderLoading = () => (
    <div className="space-y-4">
      {[...Array(3)].map((_, idx) => (
        <Card key={idx} className="premium-glass p-4">
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
    <div className="max-w-5xl mx-auto space-y-6 pb-14">
      <Card className="premium-glass border-primary/20 overflow-hidden">
        <CardContent className="p-5 md:p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-5">
          <div>
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-xl bg-primary/20 flex items-center justify-center">
                <Trophy className="h-6 w-6 text-primary" />
              </div>
              <h1 className="text-3xl font-black tracking-tight">Global Community</h1>
            </div>
            <p className="text-muted-foreground font-mono text-xs md:text-sm tracking-widest mt-2">
              Collaboration feed for engineering updates, questions, and bounty challenges.
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 w-full md:w-auto md:min-w-[420px]">
            <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Posts</p>
              <p className="text-xl font-black">{feedCounts.all}</p>
            </div>
            <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Following</p>
              <p className="text-xl font-black">{Object.values(following).filter(Boolean).length}</p>
            </div>
            <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 col-span-2 md:col-span-1">
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Open Bounties</p>
              <p className="text-xl font-black">{feedCounts.bounties}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="premium-glass border-primary/10">
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
              <Input
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Search by author, content, or tags"
                className="pl-9"
              />
            </div>
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              aria-label="Sort posts"
            >
              <option value="latest">Sort: Latest</option>
              <option value="popular">Sort: Most Popular</option>
              <option value="discussed">Sort: Most Discussed</option>
            </select>
          </div>

          <div className="flex flex-wrap gap-2">
            {feedOptions.map((option) => (
              <Button
                key={option.key}
                type="button"
                size="sm"
                variant={feedMode === option.key ? 'default' : 'outline'}
                onClick={() => setFeedMode(option.key)}
                className={cn('h-8 px-3 text-xs font-bold', feedMode === option.key ? 'bg-primary text-background-dark' : '')}
              >
                {option.label}
                <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-[10px] bg-black/10 dark:bg-white/10">
                  {option.count}
                </Badge>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="premium-glass border-primary/15">
        <CardContent className="p-4 md:p-5 flex gap-4">
          <Avatar className="h-11 w-11 border border-primary/30 shrink-0">
            <AvatarImage src={user?.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.email || 'guest'}`} />
            <AvatarFallback>{user?.name?.charAt(0) || 'U'}</AvatarFallback>
          </Avatar>

          <div className="flex-1 space-y-3">
            <Textarea
              value={newPostContent}
              onChange={(event) => setNewPostContent(event.target.value)}
              placeholder="Share a project update, blocker, lesson, or ask for peer input..."
              className="min-h-[110px]"
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input
                value={newPostImage}
                onChange={(event) => setNewPostImage(event.target.value)}
                placeholder="Optional image URL (https://...)"
              />
              <Input
                value={newPostTags}
                onChange={(event) => setNewPostTags(event.target.value)}
                placeholder="Tags (comma separated): seismic, concrete"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant={isBountyDraft ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setIsBountyDraft((prev) => !prev)}
                  className={cn(isBountyDraft ? 'bg-orange-500 hover:bg-orange-500/90 text-white' : '')}
                >
                  <Flame className="h-4 w-4 mr-2" />
                  {isBountyDraft ? 'Bounty Enabled' : 'Create Bounty'}
                </Button>

                {isBountyDraft && (
                  <Input
                    value={newBountyAmount}
                    onChange={(event) => setNewBountyAmount(event.target.value)}
                    className="w-[180px]"
                    placeholder="Bounty amount (USD)"
                  />
                )}

                <Badge variant="outline" className="text-xs">
                  <ImageIcon className="h-3 w-3 mr-1" /> Optional media
                </Badge>
              </div>

              <Button
                type="button"
                onClick={handlePostSubmit}
                disabled={isPublishing || !newPostContent.trim()}
                className="bg-primary text-background-dark font-bold px-6"
              >
                {isPublishing ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Publish'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-5">
        {isLoading ? (
          renderLoading()
        ) : visiblePosts.length === 0 ? (
          <Card className="premium-glass p-8 text-center">
            <p className="text-muted-foreground">No posts found for this feed/filter. Try another filter or publish a new update.</p>
          </Card>
        ) : (
          visiblePosts.map((post) => {
            const thread = commentThreads[post.id] || createDefaultThread();
            const isOwnPost = post.authorId === user?.uid;
            const canFollow = !isOwnPost && !post.isBounty;

            return (
              <Card key={post.id} className="premium-glass premium-glass-hover overflow-hidden transition-all duration-300">
                <CardHeader className="flex flex-row items-center justify-between gap-3 p-5 pb-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar className="h-11 w-11 border border-primary/20">
                      <AvatarImage src={post.author.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${post.author.name}`} />
                      <AvatarFallback>{post.author.name.charAt(0)}</AvatarFallback>
                    </Avatar>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <h3 className="text-sm font-bold truncate">{post.author.name}</h3>
                        {post.author.verified && <CheckCircle2 className="h-3.5 w-3.5 text-blue-400 shrink-0" />}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-primary/80 truncate">{post.author.role}</span>
                        <span>•</span>
                        <span className="flex items-center gap-1 shrink-0">
                          <Clock className="h-3 w-3" /> {formatRelativeTime(post.timestamp)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {post.isBounty && (
                      <Badge variant="outline" className="text-xs bg-orange-500/10 text-orange-500 border-orange-500/30 flex items-center gap-1">
                        <Flame className="h-3 w-3" /> ${post.bountyAmount?.toLocaleString() || 0} Bounty
                      </Badge>
                    )}

                    {canFollow && (
                      <Button
                        type="button"
                        size="sm"
                        variant={following[post.author.name] ? 'outline' : 'default'}
                        className={cn(
                          'h-8 px-3 text-xs font-bold',
                          following[post.author.name] ? '' : 'bg-primary text-background-dark'
                        )}
                        onClick={() => toggleFollow(post.author.name)}
                      >
                        <UserPlus className="h-3.5 w-3.5 mr-1" />
                        {following[post.author.name] ? 'Following' : 'Follow'}
                      </Button>
                    )}

                    {isOwnPost && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => handleDeletePost(post)}
                        aria-label="Delete post"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </CardHeader>

                <CardContent className="p-0">
                  <div className="px-5 pb-3">
                    <p className="text-sm leading-relaxed text-foreground/95 whitespace-pre-wrap">{post.content}</p>
                    <div className="flex flex-wrap gap-2 mt-3">
                      {post.tags.map((tag) => (
                        <span key={`${post.id}_${tag}`} className="text-xs font-bold text-primary">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>

                  {post.image && (
                    <div className="w-full max-h-[420px] overflow-hidden bg-black/20 border-y border-white/5">
                      <img
                        src={post.image}
                        alt="Post attachment"
                        className="w-full h-full object-cover transition-transform duration-500 hover:scale-105"
                        loading="lazy"
                      />
                    </div>
                  )}

                  <div className="flex items-center justify-between p-3 px-5 bg-slate-50 dark:bg-black/20 border-t border-slate-100 dark:border-white/5">
                    <div className="flex items-center gap-6">
                      <button
                        type="button"
                        onClick={() => handleToggleLike(post.id)}
                        className={cn(
                          'flex items-center gap-2 text-sm font-semibold transition-all',
                          post.hasLiked ? 'text-red-500' : 'text-muted-foreground hover:text-red-500'
                        )}
                      >
                        <Heart className={cn('h-5 w-5', post.hasLiked ? 'fill-current' : '')} />
                        <span>{post.likes}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => toggleComments(post.id)}
                        className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-primary transition-all"
                      >
                        <MessageCircle className="h-5 w-5" />
                        <span>{post.comments}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleShare(post)}
                        className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-primary transition-all"
                      >
                        <Share2 className="h-5 w-5" />
                        <span>{post.shares}</span>
                      </button>
                    </div>

                    <Badge variant="outline" className="text-[10px] uppercase font-bold tracking-widest border-primary/20 bg-primary/5 text-primary">
                      <Users className="h-3 w-3 mr-1" /> Verified Network
                    </Badge>
                  </div>

                  {thread.isOpen && (
                    <div className="border-t border-slate-100 dark:border-white/5 bg-slate-50/60 dark:bg-black/10 p-4 space-y-3">
                      {thread.isLoading ? (
                        <div className="space-y-2">
                          <Skeleton className="h-4 w-1/2" />
                          <Skeleton className="h-4 w-3/4" />
                        </div>
                      ) : (
                        <div className="space-y-3 max-h-52 overflow-y-auto pr-1">
                          {thread.comments.length > 0 ? (
                            thread.comments.map((comment) => (
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
                                  <p className="text-sm text-foreground/90 whitespace-pre-wrap">{comment.text}</p>
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
                          value={thread.newComment}
                          onChange={(event) =>
                            setCommentThreads((prev) => ({
                              ...prev,
                              [post.id]: {
                                ...(prev[post.id] || createDefaultThread()),
                                isOpen: true,
                                newComment: event.target.value,
                              },
                            }))
                          }
                          className="text-sm bg-white dark:bg-black/50 border-slate-200 dark:border-white/10"
                        />
                        <Button
                          size="icon"
                          disabled={thread.isSubmitting || !thread.newComment.trim()}
                          onClick={() => handleCommentSubmit(post.id)}
                        >
                          {thread.isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
