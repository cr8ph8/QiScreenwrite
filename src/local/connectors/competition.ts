// Connector to the hosted CanIScreenwrite competition system (Supabase).
//
// Loaded lazily, only when the writer opens the Competition panel, so the local
// app makes no network request until asked. The connector carries a saved local
// revision into the writer's own hosted draft (`screenplay_drafts`) and reads
// competitions, entries and scorecards. It never marks anything submitted:
// submission goes through the hosted portal's governed path
// (src/lib/submission/governedSubmit.ts), which enforces the eligibility gates.
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { parseFountain } from "@/lib/fountain-parser";
import type { ScreenplayDraftData } from "../types";
import { hostedConfiguration } from './hosted-config';

const configuration = hostedConfiguration();
export const HOSTED_ORIGIN = configuration.configured ? configuration.portal : '';

let clientPromise: Promise<SupabaseClient> | null = null;
export function getClient(): Promise<SupabaseClient> {
  const config = hostedConfiguration();
  if (!config.configured) return Promise.reject(new Error(config.message));
  clientPromise ??= import("@/integrations/supabase/client").then((module) => module.supabase as unknown as SupabaseClient);
  return clientPromise;
}

export async function currentSession(): Promise<Session | null> {
  const client = await getClient();
  return (await client.auth.getSession()).data.session;
}
export async function signInWithPassword(email: string, password: string) {
  const client = await getClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return currentSession();
}
export async function requestEmailCode(email: string) {
  const client = await getClient();
  const { error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (error) throw error;
}
export async function verifyEmailCode(email: string, token: string) {
  const client = await getClient();
  const { error } = await client.auth.verifyOtp({ email, token, type: "email" });
  if (error) throw error;
  return currentSession();
}
export async function signOut() { const client = await getClient(); await client.auth.signOut(); }

export interface Competition { id: string; title: string | null; length_category: string | null; status: string; submission_deadline: string | null; prize_pool: number | null }
export async function listCompetitions(): Promise<Competition[]> {
  const client = await getClient();
  const { data, error } = await client.from("competitions").select("id, title, length_category, status, submission_deadline, prize_pool").eq("status", "active").order("submission_deadline", { ascending: true }).limit(20);
  if (error) throw error;
  return (data ?? []) as Competition[];
}

export interface Entry { id: string; title: string; genre: string | null; status: string; length_category: string | null; page_count: number | null; created_at: string; competition_id: string | null; score?: { total_score: number | null; feedback: string | null } | null }
export async function listMyEntries(userId: string): Promise<Entry[]> {
  const client = await getClient();
  const { data, error } = await client.from("entries").select("id, title, genre, status, length_category, page_count, created_at, competition_id").eq("user_id", userId).order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  const entries = (data ?? []) as Entry[];
  if (entries.length === 0) return entries;
  const { data: scores } = await client.from("scores").select("entry_id, total_score, feedback").in("entry_id", entries.map((entry) => entry.id));
  const byEntry = new Map((scores ?? []).map((score: { entry_id: string; total_score: number | null; feedback: string | null }) => [score.entry_id, score]));
  return entries.map((entry) => ({ ...entry, score: byEntry.get(entry.id) ?? null }));
}

export interface HostedDraft { id: string; title: string; page_count: number; last_edited_at: string }
export async function readHostedDraft(id: string): Promise<HostedDraft | null> {
  const client = await getClient();
  const { data, error } = await client.from("screenplay_drafts").select("id, title, page_count, last_edited_at").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as HostedDraft | null) ?? null;
}

/** Carry a saved local revision into the writer's hosted draft. Creates it on first push, updates it afterwards. */
export async function pushToHostedDraft(userId: string, data: ScreenplayDraftData, hostedDraftId: string | null): Promise<string> {
  const client = await getClient();
  const stats = parseFountain(data.body).stats;
  const row = {
    title: data.title, format: data.projectFormat ?? null, genre: data.genre ?? null, fountain_text: data.body,
    page_count: stats.pageCount, scene_count: stats.sceneCount, total_words: stats.wordCount, parsed_stats: stats as never,
    target_page_count: data.targetPages ?? null, last_edited_at: new Date().toISOString(),
  };
  if (hostedDraftId) {
    const { data: updated, error } = await client.from("screenplay_drafts").update(row).eq("id", hostedDraftId).eq("user_id", userId).select("id").maybeSingle();
    if (error) throw error;
    if (updated?.id) return updated.id;
    // The hosted draft is gone or not ours any more: create a fresh one rather than failing silently.
  }
  const { data: inserted, error } = await client.from("screenplay_drafts").insert({ ...row, user_id: userId }).select("id").single();
  if (error) throw error;
  return inserted.id as string;
}

export const hostedWorkspaceUrl = (hostedDraftId: string, mode: "write" | "submit" | "insights" = "submit") => `${HOSTED_ORIGIN}/entry/${encodeURIComponent(hostedDraftId)}#${mode}`;

/** Read the signed-in owner's drafts for an explicit local migration. */
export interface ImportableDraft { id: string; title: string; fountain_text: string; genre: string | null; format: string | null }
export async function listHostedDrafts(userId: string): Promise<ImportableDraft[]> {
  const client = await getClient();
  const { data, error } = await client.from("screenplay_drafts").select("id,title,fountain_text,genre,format").eq("user_id", userId).order("last_edited_at", {ascending:false}).limit(100);
  if (error) throw error;
  return (data ?? []) as ImportableDraft[];
}
