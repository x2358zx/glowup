-- ==========================================
-- GlowUp 健身系統 - Supabase SQL Schema 設定檔
-- ==========================================

-- 啟用 UUID 擴充功能
create extension if not exists "uuid-ossp";

-- 1. 建立「群組」資料表
create table public.groups (
    id uuid default gen_random_uuid() primary key,
    name text not null,
    coach_email text not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 2. 建立「用戶設定檔」資料表 (關聯 auth.users)
create table public.profiles (
    id uuid references auth.users on delete cascade primary key,
    email text unique not null,
    name text not null,
    role text not null check (role in ('coach', 'student')),
    group_id uuid references public.groups(id) on delete set null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 3. 建立「教練主課表」資料表 (Master_Workouts)
create table public.master_workouts (
    id uuid default gen_random_uuid() primary key,
    group_id uuid references public.groups(id) on delete cascade not null,
    date date not null,
    exercise_id text not null,          -- 例如: EX_SQUAT_01
    exercise_name text not null,        -- 例如: 後背蹲舉
    target_sets integer not null,       -- 目標組數
    notes text,                         -- 教練備註
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 4. 建立「學生今日訓練紀錄」資料表 (Student_Active_Logs)
create table public.student_active_logs (
    id uuid default gen_random_uuid() primary key,
    master_workout_id uuid references public.master_workouts(id) on delete set null,
    group_id uuid references public.groups(id) on delete cascade not null,
    student_email text not null,
    date date not null,
    exercise_id text not null,
    exercise_name text not null,
    target_sets integer not null,
    -- 儲存組數詳情，例如: [{"set_index": 1, "reps": 10, "weight_kg": 60, "completed": true}]
    sets jsonb not null default '[]'::jsonb,
    status text not null default 'pending' check (status in ('pending', 'completed')),
    swapped_exercise_id text,           -- 學生替換的動作 ID
    swapped_exercise_name text,         -- 學生替換的動作名稱
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 建立索引以提升查詢速度
create index idx_profiles_group on public.profiles(group_id);
create index idx_master_workouts_group_date on public.master_workouts(group_id, date);
create index idx_student_logs_email_date on public.student_active_logs(student_email, date);
create index idx_student_logs_exercise on public.student_active_logs(exercise_id);

-- 啟用 Row Level Security (RLS)
alter table public.groups enable row level security;
alter table public.profiles enable row level security;
alter table public.master_workouts enable row level security;
alter table public.student_active_logs enable row level security;

-- ==========================================
-- 建立 RLS 輔助函數 (避免政策循環引用)
-- ==========================================

-- 檢查用戶是否為該群組的教練
create or replace function public.is_group_coach(group_uuid uuid)
returns boolean security definer as $$
begin
    return exists (
        select 1 from public.groups
        where id = group_uuid
        and coach_email = auth.jwt() ->> 'email'
    ) or exists (
        select 1 from public.profiles
        where id = auth.uid()
        and role = 'coach'
        and group_id = group_uuid
    );
end;
$$ language plpgsql;

-- 獲取當前登入用戶的群組 ID
create or replace function public.get_my_group_id()
returns uuid security definer as $$
begin
    return (select group_id from public.profiles where id = auth.uid());
end;
$$ language plpgsql;

-- 獲取當前登入用戶的角色
create or replace function public.get_my_role()
returns text security definer as $$
begin
    return (select role from public.profiles where id = auth.uid());
end;
$$ language plpgsql;

-- ==========================================
-- 建立 RLS 安全原則 (Policies)
-- ==========================================

-- 1. Groups 政策
create policy "允許教練和群組成員讀取群組資訊" on public.groups
    for select using (
        coach_email = auth.jwt() ->> 'email' or 
        id = public.get_my_group_id()
    );

create policy "允許教練管理（增刪改）群組" on public.groups
    for all using (
        coach_email = auth.jwt() ->> 'email'
    );

-- 2. Profiles 政策
create policy "允許同群組成員及教練讀取使用者設定檔" on public.profiles
    for select using (
        group_id = public.get_my_group_id() or
        public.is_group_coach(group_id)
    );

create policy "允許用戶更新自己的設定檔" on public.profiles
    for update using (
        id = auth.uid()
    );

-- 3. Master Workouts 政策
create policy "允許同群組成員或教練查看主課表" on public.master_workouts
    for select using (
        group_id = public.get_my_group_id() or
        public.is_group_coach(group_id)
    );

create policy "僅允許教練編輯與管理主課表" on public.master_workouts
    for all using (
        public.is_group_coach(group_id)
    );

-- 4. Student Active Logs 政策
create policy "允許學生讀寫自己的訓練紀錄，以及教練讀寫同群組紀錄" on public.student_active_logs
    for all using (
        student_email = auth.jwt() ->> 'email' or
        public.is_group_coach(group_id)
    );

-- ==========================================
-- 建立自動同步更新時間 (updated_at) 觸發器
-- ==========================================
create or replace function public.handle_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create trigger set_updated_at
before update on public.student_active_logs
for each row execute procedure public.handle_updated_at();

-- ==========================================
-- 建立 Supabase Auth 註冊自動同步至 profiles 觸發器
-- ==========================================
create or replace function public.handle_new_user()
returns trigger as $$
begin
    insert into public.profiles (id, email, name, role, group_id)
    values (
        new.id,
        new.email,
        coalesce(new.raw_user_meta_data->>'name', '新使用者'),
        coalesce(new.raw_user_meta_data->>'role', 'student'),
        (new.raw_user_meta_data->>'group_id')::uuid
    );
    return new;
end;
$$ language plpgsql;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();
