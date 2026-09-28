import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Session } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { localApi } from "../api";
import { LINK_KIND, linkId, DRAFT_KIND, newDraftId, buildDraftData } from "../model";
import * as competition from "../connectors/competition";
import { hostedConfiguration } from '../connectors/hosted-config';
import type { CompetitionLinkRemote, DraftRecord, LinkRecord, LocalProject, SyncLinkData } from "../types";

interface Props { project: LocalProject; draft: DraftRecord | null; dirty: boolean; links: LinkRecord[]; onChanged: () => Promise<void> }

/**
 * Competition system connector. Signs the writer into their own hosted account,
 * carries a saved local revision into their hosted draft, and shows their
 * competitions, entries and scorecards. Submission itself stays in the hosted
 * portal so its eligibility gates and attestations apply unchanged.
 */
export function CompetitionPanel({ project, draft, dirty, links, onChanged }: Props) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [competitions, setCompetitions] = useState<competition.Competition[]>([]);
  const [hostedDrafts, setHostedDrafts] = useState<competition.ImportableDraft[]>([]);
  const [entries, setEntries] = useState<competition.Entry[]>([]);
  const link = links.find((item) => item.data.target === "competition");
  const remote = link?.data.remote as CompetitionLinkRemote | undefined;

  useEffect(() => { if (hostedConfiguration().configured) competition.currentSession().then(setSession).catch(() => setSession(null)); }, []);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    try { await action(); } catch (error) { toast.error(error instanceof Error ? error.message : `${label} failed.`); } finally { setBusy(null); }
  };
  const loadBoards = (userId: string) => run("load", async () => {
    const [activeCompetitions, myEntries] = await Promise.all([competition.listCompetitions(), competition.listMyEntries(userId)]);
    setCompetitions(activeCompetitions); setEntries(myEntries);
  });
  useEffect(() => { if (session?.user) void loadBoards(session.user.id); }, [session?.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const push = () => run("push", async () => {
    if (!draft || !session?.user) return;
    const hostedId = await competition.pushToHostedDraft(session.user.id, draft.data, remote?.userId === session.user.id ? remote.draftId : null);
    const data: SyncLinkData = {
      schemaVersion: 1, projectId: project.id, draftId: draft.id, draftVersion: draft.version, draftSha256: draft.sha256, target: "competition",
      remote: { hostedOrigin: competition.HOSTED_ORIGIN, draftId: hostedId, userId: session.user.id, ...(remote?.entryId ? { entryId: remote.entryId } : {}) },
      linkedAt: new Date().toISOString(),
    };
    await localApi.save<SyncLinkData>({ id: linkId("competition", draft.id), kind: LINK_KIND, expectedVersion: link?.version ?? null, requestId: crypto.randomUUID(), data });
    await onChanged();
    toast.success(`Carried v${draft.version} to your hosted draft. Finish submission in CanIScreenwrite.`);
  });

  if (!hostedConfiguration().configured) return <section className="border-t border-border pt-3 text-sm"><h3 className="font-medium">Competition system</h3><p>Online services are not configured in this build. Keep writing locally; the optional CanIScreenwrite.com connection is planned separately.</p></section>;

  return (
    <section className="flex flex-col gap-2 text-sm border-t border-border pt-3">
      <div className="flex items-center gap-2"><h3 className="font-medium">Competition system</h3><span className="text-xs text-muted-foreground ml-auto">{session === undefined ? "checking" : session ? session.user.email : "signed out"}</span></div>
      {session === null && (
        <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void run("sign-in", async () => { setSession(codeSent ? await competition.verifyEmailCode(email.trim(), code.trim()) : await competition.signInWithPassword(email.trim(), password)); setPassword(""); setCode(""); }); }}>
          <p className="text-xs text-muted-foreground">Sign in to your configured service at <code>{competition.HOSTED_ORIGIN}</code>. This connection uses the internet.</p>
          <Input type="email" autoComplete="username" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
          {codeSent ? <Input inputMode="numeric" autoComplete="one-time-code" placeholder="Code from the email" value={code} onChange={(event) => setCode(event.target.value)} /> : <Input type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} />}
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" type="submit" disabled={busy !== null || !email.trim() || (codeSent ? !code.trim() : !password)}>{codeSent ? "Verify code" : "Sign in"}</Button>
            <Button size="sm" type="button" variant="ghost" disabled={busy !== null || !email.trim()} onClick={() => run("code", async () => { await competition.requestEmailCode(email.trim()); setCodeSent(true); toast.message("Check your email for a sign-in code."); })}>{codeSent ? "Resend code" : "Email me a code instead"}</Button>
          </div>
        </form>
      )}
      {session && (
        <>
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => loadBoards(session.user.id)}>Refresh</Button>
            <Button size="sm" variant="ghost" onClick={() => run("sign-out", async () => { await competition.signOut(); setSession(null); setEntries([]); setCompetitions([]); })}>Sign out</Button>
          </div>
          {draft ? (
            <div className="flex flex-col gap-1">
              <Button size="sm" disabled={busy !== null || dirty} onClick={push}>{busy === "push" ? "Carrying…" : remote ? `Update hosted draft with v${draft.version}` : `Carry v${draft.version} to my hosted drafts`}</Button>
              {dirty && <span className="text-xs text-muted-foreground">Save the draft before carrying it.</span>}
              {remote && link && (
                <span className="text-xs text-muted-foreground">Hosted draft holds v{link.data.draftVersion} · {new Date(link.data.linkedAt).toLocaleString()}{link.data.draftVersion !== draft.version ? " · local is newer" : ""} · <a className="underline" href={competition.hostedWorkspaceUrl(remote.draftId, "submit")} target="_blank" rel="noreferrer noopener">Open in CanIScreenwrite to submit</a></span>
              )}
            </div>
          ) : <span className="text-xs text-muted-foreground">Save the draft to carry it.</span>}
          <details className="text-xs">
            <summary className="cursor-pointer">Bring existing online drafts onto this Mac</summary>
            <p className="text-muted-foreground mt-2">Import a separate local copy. The online draft and any existing local versions stay intact.</p>
            <Button className="mt-2" size="sm" variant="outline" disabled={busy !== null} onClick={() => run("list drafts", async () => setHostedDrafts(await competition.listHostedDrafts(session.user.id)))}>List my latest 100 online drafts</Button>
            {hostedDrafts.map(item => <div key={item.id} className="flex items-center gap-2 mt-2"><span className="flex-1">{item.title}</span><Button size="sm" disabled={busy !== null} onClick={() => run("import", async () => {
              await localApi.save({ id: newDraftId(), kind: DRAFT_KIND, expectedVersion: null, requestId: crypto.randomUUID(), data: buildDraftData(project.id, { title:item.title, body:item.fountain_text, genre:item.genre ?? "" }) });
              await onChanged(); toast.success("Saved a local copy. It is ready for offline writing.");
            })}>Import copy</Button></div>)}
          </details>
          <details className="text-xs" open>
            <summary className="cursor-pointer">Active competitions ({competitions.length})</summary>
            <ul className="mt-1 flex flex-col gap-1">
              {competitions.map((item) => <li key={item.id}>{item.title ?? "Untitled"}{item.length_category ? ` · ${item.length_category}` : ""}{item.submission_deadline ? ` · closes ${new Date(item.submission_deadline).toLocaleDateString()}` : ""}</li>)}
              {competitions.length === 0 && <li className="text-muted-foreground">None open right now.</li>}
            </ul>
          </details>
          <details className="text-xs" open>
            <summary className="cursor-pointer">My entries ({entries.length})</summary>
            <ul className="mt-1 flex flex-col gap-1">
              {entries.map((entry) => (
                <li key={entry.id} className="flex flex-col">
                  <span><a className="underline" href={competition.hostedWorkspaceUrl(entry.id, "insights")} target="_blank" rel="noreferrer noopener">{entry.title}</a> · {entry.status}{entry.score?.total_score != null ? ` · ${entry.score.total_score}/100` : ""}</span>
                  {entry.score?.feedback && <span className="text-muted-foreground line-clamp-2">{entry.score.feedback}</span>}
                </li>
              ))}
              {entries.length === 0 && <li className="text-muted-foreground">No entries yet.</li>}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
