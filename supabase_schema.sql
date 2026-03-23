
-- Tables for Janissary Swarm .io

-- 1. user_stats table
CREATE TABLE IF NOT EXISTS public.user_stats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nickname TEXT NOT NULL,
    total_battles_count INTEGER DEFAULT 0,
    wins_count INTEGER DEFAULT 0,
    total_recruits INTEGER DEFAULT 0,
    total_kills INTEGER DEFAULT 0,
    last_played TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for leaderboard/stats
CREATE INDEX IF NOT EXISTS idx_user_stats_wins ON public.user_stats (wins_count DESC);
CREATE INDEX IF NOT EXISTS idx_user_stats_kills ON public.user_stats (total_kills DESC);

-- 2. rooms table (for basic matchmaking coordination)
CREATE TABLE IF NOT EXISTS public.rooms (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    status TEXT DEFAULT 'waiting', -- 'waiting', 'playing', 'finished'
    player_count INTEGER DEFAULT 0,
    max_players INTEGER DEFAULT 5,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE
);
