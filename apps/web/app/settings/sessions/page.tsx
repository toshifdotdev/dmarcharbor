import type { Metadata } from "next";
import { listSessions } from "@/lib/api-phase7";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import { deviceLabel } from "@/lib/user-agent";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { SessionsBoard, type SessionView } from "@/components/harbor/settings/sessions";
import { ErrorState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Signed-in devices" };

/** /settings/sessions — account level: the same list in every workspace. */
export default async function SessionsPage() {
  const ctx = await settingsContext();
  const listed = await listSessions().catch(() => null);
  const sessions: SessionView[] | null = listed
    ? [...listed.sessions]
        .sort((a, b) => Number(b.current) - Number(a.current))
        .map((s) => ({
          id: s.id,
          current: s.current,
          device: deviceLabel(s.userAgent),
          userAgent: s.userAgent || null,
          // The unspecified address (:: written out as zeros) means the API
          // did not learn one; it is not an address anyone can act on.
          ip: s.ipAddress && !/^[0:.]+$/.test(s.ipAddress) ? s.ipAddress : null,
          startedLabel: instantLabel(s.createdAt),
          endsLabel: instantLabel(s.expiresAt),
        }))
    : null;

  return (
    <SettingsFrame
      ctx={ctx}
      section="sessions"
      lede="Every device signed in as you, in any workspace. Sign out the ones you do not recognise: the cost of a wrong guess is one sign-in."
    >
      {sessions ? (
        <SessionsBoard sessions={sessions} />
      ) : (
        <ErrorState what="the list of signed-in devices" detail="No session was signed out. Retry to read the list." />
      )}
    </SettingsFrame>
  );
}
