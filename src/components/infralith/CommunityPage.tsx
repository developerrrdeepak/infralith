'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  Bookmark,
  BriefcaseBusiness,
  CheckCircle2,
  Clock,
  Flame,
  HandHeart,
  Image as ImageIcon,
  Lightbulb,
  Loader2,
  Megaphone,
  MessageCircle,
  Repeat2,
  Search,
  Send,
  Share2,
  Sparkles,
  ThumbsUp,
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
import { type Post as ServicePost, type Comment as ServiceComment, type ReactionType } from '@/lib/services';
import { postService } from '@/lib/collab-client';

type FeedMode = 'all' | 'following' | 'bounties' | 'saved' | 'mine';
type SortMode = 'latest' | 'popular' | 'discussed';
type PostType = 'update' | 'project' | 'hiring' | 'announcement';

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
  reactions: Partial<Record<ReactionType, number>>;
  reactionCount: number;
  userReaction: ReactionType | null;
  isSaved: boolean;
  saveCount: number;
  postType: PostType;
  repostOf?: string | null;
  repostPreview?: {
    authorName: string;
    content: string;
    image?: string;
    tags: string[];
    postType: PostType;
  } | null;
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
const resolveEnvText = (value: string | undefined, fallback: string) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
};
const parseBooleanEnv = (value: string | undefined, fallback = false) => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};
const COMMUNITY_COPY = {
  title: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TITLE, 'Global Community'),
  subtitle: resolveEnvText(
    process.env.NEXT_PUBLIC_COMMUNITY_SUBTITLE,
    'Collaboration feed for engineering updates, questions, and bounty challenges.'
  ),
  communityName: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_NAME, 'Infralith Community'),
  feedAll: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_FEED_ALL, 'All'),
  feedFollowing: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_FEED_FOLLOWING, 'Following'),
  feedBounties: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_FEED_BOUNTIES, 'Bounties'),
  feedSaved: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_FEED_SAVED, 'Saved'),
  feedMine: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_FEED_MINE, 'My Posts'),
  statPosts: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_STAT_POSTS, 'Posts'),
  statFollowing: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_STAT_FOLLOWING, 'Following'),
  statOpenBounties: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_STAT_OPEN_BOUNTIES, 'Open Bounties'),
  searchPlaceholder: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_SEARCH_PLACEHOLDER, 'Search by author, content, or tags'),
  sortLatest: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_SORT_LATEST, 'Sort: Latest'),
  sortPopular: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_SORT_POPULAR, 'Sort: Most Popular'),
  sortDiscussed: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_SORT_DISCUSSED, 'Sort: Most Discussed'),
  composePlaceholder: resolveEnvText(
    process.env.NEXT_PUBLIC_COMMUNITY_COMPOSE_PLACEHOLDER,
    'Share a project update, blocker, lesson, or ask for peer input...'
  ),
  imageUrlPlaceholder: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_IMAGE_PLACEHOLDER, 'Optional image URL (https://...)'),
  tagsPlaceholder: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TAGS_PLACEHOLDER, 'Tags (comma separated): seismic, concrete'),
  uploadImage: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_UPLOAD_IMAGE, 'Upload Image'),
  createBounty: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_CREATE_BOUNTY, 'Create Bounty'),
  bountyEnabled: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_BOUNTY_ENABLED, 'Bounty Enabled'),
  bountyAmountPlaceholder: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_BOUNTY_AMOUNT_PLACEHOLDER, 'Bounty amount (USD)'),
  publish: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_PUBLISH_LABEL, 'Publish'),
  repost: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_REPOST_LABEL, 'Repost'),
  follow: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_FOLLOW_LABEL, 'Follow'),
  following: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_FOLLOWING_LABEL, 'Following'),
  unfollowed: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_UNFOLLOWED_LABEL, 'Unfollowed'),
  verifiedNetwork: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_VERIFIED_NETWORK, 'Verified Network'),
  noPostsMessage: resolveEnvText(
    process.env.NEXT_PUBLIC_COMMUNITY_EMPTY_FEED,
    'No posts found for this feed/filter. Try another filter or publish a new update.'
  ),
  noCommentsMessage: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_NO_COMMENTS, 'No comments yet. Start the conversation.'),
  commentPlaceholder: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_COMMENT_PLACEHOLDER, 'Add a constructive comment'),
  shareTitle: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_SHARE_TITLE, 'Community Update'),
  shareBodyPrefix: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_SHARE_PREFIX, 'posted on'),
  postImageAlt: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_POST_IMAGE_ALT, 'Post attachment'),
  uploadPreviewAlt: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_UPLOAD_PREVIEW_ALT, 'Upload preview'),
  removeImage: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_REMOVE_IMAGE, 'Remove'),
  deleteConfirm: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_DELETE_CONFIRM, 'Delete this post permanently?'),
  deletePostAriaLabel: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_DELETE_POST_ARIA, 'Delete post'),
  repostPrompt: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_REPOST_PROMPT, 'Add commentary for repost (optional):'),
  sortAriaLabel: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_SORT_ARIA, 'Sort posts'),
  postTypeAriaLabel: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_POST_TYPE_ARIA, 'Post type'),
  postTypeUpdateLabel: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_POSTTYPE_UPDATE, 'Update'),
  postTypeUpdateHint: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_POSTTYPE_UPDATE_HINT, 'General status update'),
  postTypeProjectLabel: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_POSTTYPE_PROJECT, 'Project'),
  postTypeProjectHint: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_POSTTYPE_PROJECT_HINT, 'Milestone or showcase'),
  postTypeHiringLabel: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_POSTTYPE_HIRING, 'Hiring'),
  postTypeHiringHint: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_POSTTYPE_HIRING_HINT, 'Roles and opportunities'),
  postTypeAnnouncementLabel: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_POSTTYPE_ANNOUNCEMENT, 'Announcement'),
  postTypeAnnouncementHint: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_POSTTYPE_ANNOUNCEMENT_HINT, 'Important notice'),
  reactionLikeLabel: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_REACTION_LIKE, 'Like'),
  reactionInsightfulLabel: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_REACTION_INSIGHTFUL, 'Insightful'),
  reactionCelebrateLabel: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_REACTION_CELEBRATE, 'Celebrate'),
  reactionSupportLabel: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_REACTION_SUPPORT, 'Support'),
  bountySuffix: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_BOUNTY_SUFFIX, 'Bounty'),
};
const COMMUNITY_TOAST = {
  loadFeedFailed: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_LOAD_FAILED, 'Could not load community feed'),
  loginRequired: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_LOGIN_REQUIRED, 'Login required'),
  followLoginDescription: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_FOLLOW_LOGIN, 'Sign in to follow members.'),
  followDescription: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_FOLLOWED_DESC, 'You will now see this member in your Following feed.'),
  unfollowDescription: resolveEnvText(
    process.env.NEXT_PUBLIC_COMMUNITY_TOAST_UNFOLLOWED_DESC,
    'This member has been removed from your Following feed.'
  ),
  unsupportedFileTitle: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_UNSUPPORTED_FILE, 'Unsupported file'),
  unsupportedFileDescription: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_UNSUPPORTED_FILE_DESC, 'Please upload a valid image.'),
  imageTooLargeTitle: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_IMAGE_TOO_LARGE, 'Image too large'),
  imageTooLargeDescription: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_IMAGE_TOO_LARGE_DESC, 'Upload an image smaller than 4MB.'),
  publishLoginDescription: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_PUBLISH_LOGIN, 'Sign in to publish updates.'),
  postEmptyTitle: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_POST_EMPTY, 'Post is empty'),
  postEmptyDescription: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_POST_EMPTY_DESC, 'Add text or image before publishing.'),
  invalidImageTitle: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_INVALID_IMAGE, 'Invalid image URL'),
  invalidImageDescription: resolveEnvText(
    process.env.NEXT_PUBLIC_COMMUNITY_TOAST_INVALID_IMAGE_DESC,
    'Image URL must start with http:// or https://.'
  ),
  invalidBountyTitle: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_INVALID_BOUNTY, 'Invalid bounty amount'),
  invalidBountyDescription: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_INVALID_BOUNTY_DESC, 'Enter a positive bounty amount.'),
  postPublishedTitle: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_POST_PUBLISHED, 'Post published'),
  publishFailedTitle: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_PUBLISH_FAILED, 'Could not publish post'),
  reactLoginDescription: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_REACT_LOGIN, 'Sign in to react to posts.'),
  reactionFailed: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_REACTION_FAILED, 'Could not update reaction'),
  saveLoginDescription: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_SAVE_LOGIN, 'Sign in to save posts.'),
  savedTitle: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_SAVED, 'Saved'),
  unsavedTitle: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_UNSAVED, 'Removed from saved'),
  saveFailed: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_SAVE_FAILED, 'Could not update saved posts'),
  repostLoginDescription: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_REPOST_LOGIN, 'Sign in to repost.'),
  repostedTitle: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_REPOSTED, 'Reposted'),
  repostedDescription: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_REPOSTED_DESC, 'Shared to your network feed.'),
  repostFailed: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_REPOST_FAILED, 'Could not repost'),
  commentsLoadFailed: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_COMMENTS_LOAD_FAILED, 'Could not load comments'),
  commentLoginDescription: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_COMMENT_LOGIN, 'Sign in to comment.'),
  commentFailed: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_COMMENT_FAILED, 'Could not post comment'),
  sharedTitle: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_SHARED, 'Shared'),
  sharedDescription: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_SHARED_DESC, 'Post copied/shared successfully.'),
  shareFailed: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_SHARE_FAILED, 'Share failed'),
  postDeletedTitle: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_DELETED, 'Post deleted'),
  deleteFailed: resolveEnvText(process.env.NEXT_PUBLIC_COMMUNITY_TOAST_DELETE_FAILED, 'Could not delete post'),
};
const ENABLE_SEED_POSTS = parseBooleanEnv(process.env.NEXT_PUBLIC_COMMUNITY_ENABLE_SEED, false);
const REACTION_ORDER: ReactionType[] = ['like', 'insightful', 'celebrate', 'support'];
const POST_TYPE_OPTIONS: Array<{
  key: PostType;
  label: string;
  icon: any;
  hint: string;
}> = [
  { key: 'update', label: COMMUNITY_COPY.postTypeUpdateLabel, icon: Megaphone, hint: COMMUNITY_COPY.postTypeUpdateHint },
  { key: 'project', label: COMMUNITY_COPY.postTypeProjectLabel, icon: BriefcaseBusiness, hint: COMMUNITY_COPY.postTypeProjectHint },
  { key: 'hiring', label: COMMUNITY_COPY.postTypeHiringLabel, icon: Users, hint: COMMUNITY_COPY.postTypeHiringHint },
  { key: 'announcement', label: COMMUNITY_COPY.postTypeAnnouncementLabel, icon: Sparkles, hint: COMMUNITY_COPY.postTypeAnnouncementHint },
];

const REACTION_META: Record<ReactionType, { label: string; icon: any; className: string }> = {
  like: { label: COMMUNITY_COPY.reactionLikeLabel, icon: ThumbsUp, className: 'text-blue-500' },
  insightful: { label: COMMUNITY_COPY.reactionInsightfulLabel, icon: Lightbulb, className: 'text-amber-500' },
  celebrate: { label: COMMUNITY_COPY.reactionCelebrateLabel, icon: Sparkles, className: 'text-fuchsia-500' },
  support: { label: COMMUNITY_COPY.reactionSupportLabel, icon: HandHeart, className: 'text-emerald-500' },
};

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
    reactions: { like: 306, insightful: 24, celebrate: 8, support: 4 },
    reactionCount: 342,
    userReaction: null,
    isSaved: false,
    saveCount: 22,
    postType: 'project',
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
    reactions: { like: 101, insightful: 12, celebrate: 6, support: 9 },
    reactionCount: 128,
    userReaction: null,
    isSaved: false,
    saveCount: 9,
    postType: 'update',
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
    reactions: { like: 511, insightful: 20, celebrate: 24, support: 12 },
    reactionCount: 567,
    userReaction: null,
    isSaved: false,
    saveCount: 30,
    postType: 'announcement',
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
    reactions: { like: 8, insightful: 1, celebrate: 1, support: 2 },
    reactionCount: 12,
    userReaction: null,
    isSaved: false,
    saveCount: 3,
    postType: 'hiring',
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
  const reactions: Record<string, ReactionType> = { ...(raw.reactions || {}) };
  Object.entries(raw.likes || {}).forEach(([uid, liked]) => {
    if (liked && !reactions[uid]) reactions[uid] = 'like';
  });

  const reactionTotals = REACTION_ORDER.reduce((acc, type) => {
    acc[type] = 0;
    return acc;
  }, {} as Partial<Record<ReactionType, number>>);
  Object.values(reactions).forEach((reaction) => {
    reactionTotals[reaction] = (reactionTotals[reaction] || 0) + 1;
  });

  const likeCountFromRaw = typeof raw.likeCount === 'number' ? raw.likeCount : reactionTotals.like || 0;
  if ((reactionTotals.like || 0) < likeCountFromRaw) {
    reactionTotals.like = likeCountFromRaw;
  }

  const reactionCount = typeof raw.reactionCount === 'number'
    ? raw.reactionCount
    : Math.max(
        likeCountFromRaw,
        REACTION_ORDER.reduce((sum, type) => sum + (reactionTotals[type] || 0), 0)
      );

  const savedBy = raw.savedBy || {};
  const postType = (raw.postType as PostType | undefined) || (raw.isBounty ? 'hiring' : 'update');

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
    likes: likeCountFromRaw,
    hasLiked: !!(userId && reactions[userId] === 'like'),
    reactions: reactionTotals,
    reactionCount,
    userReaction: userId ? reactions[userId] || null : null,
    isSaved: !!(userId && savedBy[userId]),
    saveCount: typeof raw.saveCount === 'number' ? raw.saveCount : Object.keys(savedBy).length,
    postType,
    repostOf: raw.repostOf || null,
    repostPreview: raw.repostPreview
      ? {
          authorName: raw.repostPreview.authorName,
          content: raw.repostPreview.content,
          image: raw.repostPreview.image || undefined,
          tags: Array.isArray(raw.repostPreview.tags) ? raw.repostPreview.tags : [],
          postType: ((raw.repostPreview.postType as PostType | undefined) || 'update'),
        }
      : null,
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
  const [newPostType, setNewPostType] = useState<PostType>('update');
  const [newPostImage, setNewPostImage] = useState('');
  const [newPostImageData, setNewPostImageData] = useState<string | null>(null);
  const [newPostTags, setNewPostTags] = useState('');
  const [isBountyDraft, setIsBountyDraft] = useState(false);
  const [newBountyAmount, setNewBountyAmount] = useState('5000');
  const imageUploadRef = useRef<HTMLInputElement | null>(null);

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

  const refreshPosts = useCallback(async () => {
    try {
      const data = await postService.getAllPosts();
      setPosts(data.map((item) => toPostView(item, user?.uid)));
    } catch (error) {
      console.error('Failed to refresh community feed', error);
    }
  }, [user?.uid]);

  useEffect(() => {
    let cancelled = false;

    const loadPosts = async () => {
      setIsLoading(true);
      try {
        let data = await postService.getAllPosts();

        if (data.length === 0 && ENABLE_SEED_POSTS) {
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
              reactionCount: post.reactionCount,
              likeCount: post.likes,
              commentCount: post.comments,
              shares: post.shares,
              tags: post.tags,
              postType: post.postType,
              saveCount: post.saveCount,
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
          if (ENABLE_SEED_POSTS) {
            setPosts(MOCK_POSTS.map((post) => ({ ...post, hasLiked: false })));
          } else {
            setPosts([]);
          }
          toast({ variant: 'destructive', title: COMMUNITY_TOAST.loadFeedFailed });
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

  useEffect(() => {
    if (!user?.uid) return;

    const pollTimer = setInterval(() => {
      void refreshPosts();
    }, 15000);

    let eventSource: EventSource | null = null;
    const onRealtimeUpdate = () => {
      void refreshPosts();
    };

    if (typeof EventSource !== 'undefined') {
      eventSource = new EventSource('/api/infralith/community/stream');
      eventSource.addEventListener('update', onRealtimeUpdate);
    }

    return () => {
      clearInterval(pollTimer);
      if (eventSource) {
        eventSource.removeEventListener('update', onRealtimeUpdate);
        eventSource.close();
      }
    };
  }, [user?.uid, refreshPosts]);

  const feedCounts = useMemo(() => {
    const followingPosts = posts.filter((post) => !!following[post.authorId]).length;
    const bountyPosts = posts.filter((post) => post.isBounty).length;
    const savedPosts = posts.filter((post) => post.isSaved).length;
    const myPosts = posts.filter((post) => post.authorId === user?.uid).length;
    return {
      all: posts.length,
      following: followingPosts,
      bounties: bountyPosts,
      saved: savedPosts,
      mine: myPosts,
    };
  }, [posts, following, user?.uid]);

  const visiblePosts = useMemo(() => {
    let result = [...posts];

    if (feedMode === 'following') {
      result = result.filter((post) => !!following[post.authorId]);
    }
    if (feedMode === 'bounties') {
      result = result.filter((post) => !!post.isBounty);
    }
    if (feedMode === 'saved') {
      result = result.filter((post) => !!post.isSaved);
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
      result.sort((a, b) => b.reactionCount + b.shares * 2 - (a.reactionCount + a.shares * 2));
    } else if (sortMode === 'discussed') {
      result.sort((a, b) => b.comments - a.comments || b.timestamp - a.timestamp);
    } else {
      result.sort((a, b) => b.timestamp - a.timestamp);
    }

    return result;
  }, [posts, feedMode, following, searchText, sortMode, user?.uid]);

  const toggleFollow = (authorId: string, authorName: string) => {
    if (!followingKey) {
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.loginRequired, description: COMMUNITY_TOAST.followLoginDescription });
      return;
    }

    setFollowing((prev) => {
      const isFollowing = !prev[authorId];
      const next = { ...prev, [authorId]: isFollowing };
      persistFollowing(next);
      toast({
        title: isFollowing ? `${COMMUNITY_COPY.following} ${authorName}` : `${COMMUNITY_COPY.unfollowed} ${authorName}`,
        description: isFollowing
          ? COMMUNITY_TOAST.followDescription
          : COMMUNITY_TOAST.unfollowDescription,
      });
      return next;
    });
  };

  const handleImageSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.unsupportedFileTitle, description: COMMUNITY_TOAST.unsupportedFileDescription });
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.imageTooLargeTitle, description: COMMUNITY_TOAST.imageTooLargeDescription });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setNewPostImageData((reader.result as string) || null);
      setNewPostImage('');
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  };

  const handleClearImageSelection = () => {
    setNewPostImage('');
    setNewPostImageData(null);
  };

  const handlePostSubmit = async () => {
    if (!user?.uid) {
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.loginRequired, description: COMMUNITY_TOAST.publishLoginDescription });
      return;
    }

    const content = newPostContent.trim();
    const imageUrl = newPostImage.trim();
    const image = newPostImageData || imageUrl;
    const tags = parseTags(newPostTags);

    if (!content && !image) {
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.postEmptyTitle, description: COMMUNITY_TOAST.postEmptyDescription });
      return;
    }
    if (imageUrl && !isValidHttpUrl(imageUrl)) {
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.invalidImageTitle, description: COMMUNITY_TOAST.invalidImageDescription });
      return;
    }

    let bountyAmount: number | undefined;
    if (isBountyDraft) {
      const parsedBounty = Number(newBountyAmount);
      if (!Number.isFinite(parsedBounty) || parsedBounty <= 0) {
        toast({ variant: 'destructive', title: COMMUNITY_TOAST.invalidBountyTitle, description: COMMUNITY_TOAST.invalidBountyDescription });
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
          postType: newPostType,
        }
      );

      const created = await postService.getPostById(postId);
      if (created) {
        setPosts((prev) => [toPostView(created, user.uid), ...prev.filter((post) => post.id !== postId)]);
      }
      setNewPostContent('');
      setNewPostImage('');
      setNewPostImageData(null);
      setNewPostTags('');
      setIsBountyDraft(false);
      setNewPostType('update');
      setNewBountyAmount('5000');
      toast({ title: COMMUNITY_TOAST.postPublishedTitle, description: `Your update is now live in ${COMMUNITY_COPY.title}.` });
    } catch (error) {
      console.error('Failed to publish post', error);
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.publishFailedTitle });
    } finally {
      setIsPublishing(false);
    }
  };

  const handleReaction = async (postId: string, reaction: ReactionType) => {
    if (!user?.uid) {
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.loginRequired, description: COMMUNITY_TOAST.reactLoginDescription });
      return;
    }

    try {
      const post = posts.find((item) => item.id === postId);
      if (!post) return;
      const nextReaction = post.userReaction === reaction ? null : reaction;
      const result = await postService.setReaction(postId, user.uid, nextReaction);
      if (!result) return;

      setPosts((prev) =>
        prev.map((post) => {
          if (post.id !== postId) return post;
          return {
            ...post,
            hasLiked: result.userReaction === 'like',
            likes: result.likeCount || 0,
            reactions: result.reactionTotals || post.reactions,
            reactionCount: result.reactionCount || 0,
            userReaction: result.userReaction,
          };
        })
      );
    } catch (error) {
      console.error('Failed to set reaction', error);
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.reactionFailed });
    }
  };

  const handleToggleSave = async (postId: string) => {
    if (!user?.uid) {
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.loginRequired, description: COMMUNITY_TOAST.saveLoginDescription });
      return;
    }
    try {
      const result = await postService.toggleSave(postId, user.uid);
      setPosts((prev) =>
        prev.map((post) =>
          post.id === postId
            ? {
                ...post,
                isSaved: result.saved,
                saveCount: result.saveCount,
              }
            : post
        )
      );
      toast({ title: result.saved ? COMMUNITY_TOAST.savedTitle : COMMUNITY_TOAST.unsavedTitle });
    } catch (error) {
      console.error('Failed to toggle save', error);
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.saveFailed });
    }
  };

  const handleRepost = async (post: Post) => {
    if (!user?.uid) {
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.loginRequired, description: COMMUNITY_TOAST.repostLoginDescription });
      return;
    }

    const quote = window.prompt(COMMUNITY_COPY.repostPrompt, '');
    if (quote === null) return;

    try {
      const postId = await postService.createRepost(
        user.uid,
        user.name || user.email || 'Engineer',
        user.avatar || '',
        user.email || '',
        post.id,
        quote,
        { authorRole: user.role || 'Engineer', verified: false }
      );
      const repost = await postService.getPostById(postId);
      if (repost) {
        setPosts((prev) => [toPostView(repost, user.uid), ...prev]);
      }
      toast({ title: COMMUNITY_TOAST.repostedTitle, description: COMMUNITY_TOAST.repostedDescription });
    } catch (error) {
      console.error('Failed to repost', error);
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.repostFailed });
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
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.commentsLoadFailed });
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
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.loginRequired, description: COMMUNITY_TOAST.commentLoginDescription });
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
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.commentFailed });
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
    const shareText = `${post.author.name} ${COMMUNITY_COPY.shareBodyPrefix} ${COMMUNITY_COPY.title}:\n\n${post.content}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: COMMUNITY_COPY.shareTitle, text: shareText });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(shareText);
      } else {
        throw new Error('No share support');
      }

      await postService.incrementShare(post.id);
      setPosts((prev) => prev.map((item) => (item.id === post.id ? { ...item, shares: item.shares + 1 } : item)));
      toast({ title: COMMUNITY_TOAST.sharedTitle, description: COMMUNITY_TOAST.sharedDescription });
    } catch (error: any) {
      if (error?.name === 'AbortError') return;
      console.error('Share failed', error);
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.shareFailed });
    }
  };

  const handleDeletePost = async (post: Post) => {
    if (!user?.uid || post.authorId !== user.uid) return;

    const confirmed = window.confirm(COMMUNITY_COPY.deleteConfirm);
    if (!confirmed) return;

    try {
      await postService.deletePost(post.id);
      setPosts((prev) => prev.filter((item) => item.id !== post.id));
      setCommentThreads((prev) => {
        const next = { ...prev };
        delete next[post.id];
        return next;
      });
      toast({ title: COMMUNITY_TOAST.postDeletedTitle });
    } catch (error) {
      console.error('Failed to delete post', error);
      toast({ variant: 'destructive', title: COMMUNITY_TOAST.deleteFailed });
    }
  };

  const feedOptions: Array<{ key: FeedMode; label: string; count: number }> = [
    { key: 'all', label: COMMUNITY_COPY.feedAll, count: feedCounts.all },
    { key: 'following', label: COMMUNITY_COPY.feedFollowing, count: feedCounts.following },
    { key: 'bounties', label: COMMUNITY_COPY.feedBounties, count: feedCounts.bounties },
    { key: 'saved', label: COMMUNITY_COPY.feedSaved, count: feedCounts.saved },
    { key: 'mine', label: COMMUNITY_COPY.feedMine, count: feedCounts.mine },
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
              <h1 className="text-3xl font-black tracking-tight">{COMMUNITY_COPY.title}</h1>
            </div>
            <p className="text-muted-foreground font-mono text-xs md:text-sm tracking-widest mt-2">
              {COMMUNITY_COPY.subtitle}
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 w-full md:w-auto md:min-w-[420px]">
            <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">{COMMUNITY_COPY.statPosts}</p>
              <p className="text-xl font-black">{feedCounts.all}</p>
            </div>
            <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">{COMMUNITY_COPY.statFollowing}</p>
              <p className="text-xl font-black">{Object.values(following).filter(Boolean).length}</p>
            </div>
            <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 col-span-2 md:col-span-1">
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">{COMMUNITY_COPY.statOpenBounties}</p>
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
                placeholder={COMMUNITY_COPY.searchPlaceholder}
                className="pl-9"
              />
            </div>
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              aria-label={COMMUNITY_COPY.sortAriaLabel}
            >
              <option value="latest">{COMMUNITY_COPY.sortLatest}</option>
              <option value="popular">{COMMUNITY_COPY.sortPopular}</option>
              <option value="discussed">{COMMUNITY_COPY.sortDiscussed}</option>
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
              placeholder={COMMUNITY_COPY.composePlaceholder}
              className="min-h-[110px]"
            />

            {newPostImageData && (
              <div className="relative rounded-xl overflow-hidden border border-primary/20 bg-black/10 max-h-[280px]">
                <img src={newPostImageData} alt={COMMUNITY_COPY.uploadPreviewAlt} className="w-full h-full object-cover" />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="absolute right-3 top-3"
                  onClick={handleClearImageSelection}
                >
                  {COMMUNITY_COPY.removeImage}
                </Button>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <select
                value={newPostType}
                onChange={(event) => setNewPostType(event.target.value as PostType)}
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                aria-label={COMMUNITY_COPY.postTypeAriaLabel}
              >
                {POST_TYPE_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
              <Input
                value={newPostImage}
                onChange={(event) => setNewPostImage(event.target.value)}
                placeholder={COMMUNITY_COPY.imageUrlPlaceholder}
              />
              <Input
                value={newPostTags}
                onChange={(event) => setNewPostTags(event.target.value)}
                placeholder={COMMUNITY_COPY.tagsPlaceholder}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={imageUploadRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleImageSelection}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => imageUploadRef.current?.click()}
                >
                  <ImageIcon className="h-4 w-4 mr-2" />
                  {COMMUNITY_COPY.uploadImage}
                </Button>
                <Button
                  type="button"
                  variant={isBountyDraft ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setIsBountyDraft((prev) => !prev)}
                  className={cn(isBountyDraft ? 'bg-orange-500 hover:bg-orange-500/90 text-white' : '')}
                >
                  <Flame className="h-4 w-4 mr-2" />
                  {isBountyDraft ? COMMUNITY_COPY.bountyEnabled : COMMUNITY_COPY.createBounty}
                </Button>

                {isBountyDraft && (
                  <Input
                    value={newBountyAmount}
                    onChange={(event) => setNewBountyAmount(event.target.value)}
                    className="w-[180px]"
                    placeholder={COMMUNITY_COPY.bountyAmountPlaceholder}
                  />
                )}

                <Badge variant="outline" className="text-xs">
                  {POST_TYPE_OPTIONS.find((option) => option.key === newPostType)?.hint}
                </Badge>
              </div>

              <Button
                type="button"
                onClick={handlePostSubmit}
                disabled={isPublishing || (!newPostContent.trim() && !newPostImage.trim() && !newPostImageData)}
                className="bg-primary text-background-dark font-bold px-6"
              >
                {isPublishing ? <Loader2 className="h-4 w-4 animate-spin" /> : COMMUNITY_COPY.publish}
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
            <p className="text-muted-foreground">{COMMUNITY_COPY.noPostsMessage}</p>
          </Card>
        ) : (
          visiblePosts.map((post) => {
            const thread = commentThreads[post.id] || createDefaultThread();
            const isOwnPost = post.authorId === user?.uid;
            const canFollow = !isOwnPost && !post.isBounty;
            const postTypeMeta = POST_TYPE_OPTIONS.find((option) => option.key === post.postType) || POST_TYPE_OPTIONS[0];
            const PostTypeIcon = postTypeMeta.icon;

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
                        <Flame className="h-3 w-3" /> ${post.bountyAmount?.toLocaleString() || 0} {COMMUNITY_COPY.bountySuffix}
                      </Badge>
                    )}
                    <Badge variant="secondary" className="text-[10px] uppercase tracking-widest font-bold flex items-center gap-1">
                      <PostTypeIcon className="h-3 w-3" />
                      {postTypeMeta.label}
                    </Badge>

                    {canFollow && (
                      <Button
                        type="button"
                        size="sm"
                        variant={following[post.authorId] ? 'outline' : 'default'}
                        className={cn(
                          'h-8 px-3 text-xs font-bold',
                          following[post.authorId] ? '' : 'bg-primary text-background-dark'
                        )}
                        onClick={() => toggleFollow(post.authorId, post.author.name)}
                      >
                        <UserPlus className="h-3.5 w-3.5 mr-1" />
                        {following[post.authorId] ? COMMUNITY_COPY.following : COMMUNITY_COPY.follow}
                      </Button>
                    )}

                    {isOwnPost && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => handleDeletePost(post)}
                        aria-label={COMMUNITY_COPY.deletePostAriaLabel}
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

                    {post.repostPreview && (
                      <div className="mt-3 rounded-xl border border-primary/15 bg-primary/5 p-3 space-y-2">
                        <p className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">{COMMUNITY_COPY.repost}</p>
                        <p className="text-xs text-foreground font-semibold">{post.repostPreview.authorName}</p>
                        <p className="text-xs text-muted-foreground whitespace-pre-wrap">{post.repostPreview.content}</p>
                      </div>
                    )}
                  </div>

                  {post.image && (
                    <div className="w-full max-h-[420px] overflow-hidden bg-black/20 border-y border-white/5">
                      <img
                        src={post.image}
                        alt={COMMUNITY_COPY.postImageAlt}
                        className="w-full h-full object-cover transition-transform duration-500 hover:scale-105"
                        loading="lazy"
                      />
                    </div>
                  )}

                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 p-3 px-5 bg-slate-50 dark:bg-black/20 border-t border-slate-100 dark:border-white/5">
                    <div className="flex flex-wrap items-center gap-2">
                      {REACTION_ORDER.map((reactionKey) => {
                        const config = REACTION_META[reactionKey];
                        const Icon = config.icon;
                        const active = post.userReaction === reactionKey;
                        return (
                          <button
                            key={`${post.id}_${reactionKey}`}
                            type="button"
                            onClick={() => handleReaction(post.id, reactionKey)}
                            className={cn(
                              'flex items-center gap-1.5 text-xs font-semibold rounded-full px-2.5 py-1 border transition-all',
                              active
                                ? 'bg-primary/15 text-primary border-primary/25'
                                : 'bg-white/70 dark:bg-black/40 text-muted-foreground border-transparent hover:border-primary/20'
                            )}
                          >
                            <Icon className={cn('h-3.5 w-3.5', active ? 'text-primary' : config.className)} />
                            <span>{post.reactions[reactionKey] || 0}</span>
                          </button>
                        );
                      })}

                      <button
                        type="button"
                        onClick={() => toggleComments(post.id)}
                        className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-primary transition-all px-2"
                      >
                        <MessageCircle className="h-5 w-5" />
                        <span>{post.comments}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleShare(post)}
                        className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-primary transition-all px-2"
                      >
                        <Share2 className="h-5 w-5" />
                        <span>{post.shares}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleRepost(post)}
                        className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-primary transition-all px-2"
                      >
                        <Repeat2 className="h-4 w-4" />
                        <span>{COMMUNITY_COPY.repost}</span>
                      </button>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleToggleSave(post.id)}
                        className={cn(
                          'flex items-center gap-1.5 text-xs font-semibold rounded-full px-2.5 py-1 border transition-all',
                          post.isSaved
                            ? 'bg-primary/15 text-primary border-primary/25'
                            : 'bg-white/70 dark:bg-black/40 text-muted-foreground border-transparent hover:border-primary/20'
                        )}
                      >
                        <Bookmark className={cn('h-3.5 w-3.5', post.isSaved ? 'fill-current' : '')} />
                        <span>{post.saveCount}</span>
                      </button>

                      <Badge variant="outline" className="text-[10px] uppercase font-bold tracking-widest border-primary/20 bg-primary/5 text-primary">
                        <Users className="h-3 w-3 mr-1" /> {COMMUNITY_COPY.verifiedNetwork}
                      </Badge>
                    </div>
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
                            <p className="text-sm text-muted-foreground">{COMMUNITY_COPY.noCommentsMessage}</p>
                          )}
                        </div>
                      )}

                      <div className="flex items-start gap-2">
                        <Textarea
                          placeholder={COMMUNITY_COPY.commentPlaceholder}
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
