import { z } from 'zod';
import type { KnownContact, WhatsAppUserProfileNames } from '@wabs/plugin-sdk/transport';
import {
  ADDRESS_BOOK_SYNC_PLUGIN_ID,
  appendAddressBookSuffix,
  selectAddressBookContactName
} from './sync';

export const historicalAddressBookContactSaveAuditSchema = z.object({
  pluginId: z.literal(ADDRESS_BOOK_SYNC_PLUGIN_ID),
  actionType: z.literal('contact.saveToAddressBook'),
  action: z.object({
    type: z.literal('contact.saveToAddressBook'),
    wid: z.string().trim().min(1),
    contactName: z.string().trim().min(1).optional(),
    displayName: z.string().trim().min(1).optional(),
    sourceGroupWid: z.string().trim().min(1).optional()
  }).passthrough().refine(action => Boolean(action.contactName ?? action.displayName), 'Saved contact name is missing')
}).passthrough();

export type AddressBookSyncRepairSkipReason =
  | 'contact-not-found'
  | 'contact-name-changed'
  | 'profile-name-unavailable'
  | 'missing-group-context'
  | 'already-correct';

export interface HistoricalAddressBookContactSaveAuditRow {
  id: string;
  groupId?: string | null | undefined;
  targetJson: unknown;
}

export interface AddressBookSyncRepairCandidate {
  auditId: string;
  groupId?: string | undefined;
  wid: string;
  oldContactName: string;
  suffix: string;
  sourceGroupWid?: string | undefined;
}

export interface AddressBookSyncRepairResult {
  auditId: string;
  wid: string;
  oldContactName: string;
  status: 'would_repair' | 'repair_requested' | 'skipped';
  contactName?: string | undefined;
  nameSource?: 'push-name' | 'identity-display-name' | 'username' | undefined;
  reason?: AddressBookSyncRepairSkipReason | undefined;
}

export interface AddressBookSyncRepairPlanItem {
  candidate: AddressBookSyncRepairCandidate & { groupId: string; sourceGroupWid: string };
  contactName: string;
  nameSource: 'push-name' | 'identity-display-name' | 'username';
}

export function findAddressBookSyncRepairCandidates(input: {
  auditRows: HistoricalAddressBookContactSaveAuditRow[];
  knownContacts: KnownContact[];
  chatId?: string | undefined;
}): {
  candidates: AddressBookSyncRepairCandidate[];
  preliminaryResults: AddressBookSyncRepairResult[];
  nonPhoneFallbackCount: number;
} {
  const parsedAuditCandidates: AddressBookSyncRepairCandidate[] = [];
  let nonPhoneFallbackCount = 0;
  for (const row of input.auditRows) {
    const audit = historicalAddressBookContactSaveAuditSchema.safeParse(row.targetJson);
    if (!audit.success) continue;
    if (input.chatId && audit.data.action.sourceGroupWid !== input.chatId) continue;
    const savedName = (audit.data.action.contactName ?? audit.data.action.displayName)!;
    const suffix = historicalPhoneFallbackSuffix(savedName, audit.data.action.wid);
    if (suffix === undefined) {
      nonPhoneFallbackCount += 1;
      continue;
    }
    parsedAuditCandidates.push({
      auditId: row.id,
      ...(row.groupId ? { groupId: row.groupId } : {}),
      wid: audit.data.action.wid,
      oldContactName: savedName,
      suffix,
      ...(audit.data.action.sourceGroupWid ? { sourceGroupWid: audit.data.action.sourceGroupWid } : {})
    });
  }

  const knownContactsByWid = new Map(
    input.knownContacts.map((contact) => [normalizeAddressBookWid(contact.wid), contact])
  );
  const candidateByWid = new Map<string, AddressBookSyncRepairCandidate>();
  const preliminaryResults: AddressBookSyncRepairResult[] = [];
  const candidatesByWid = new Map<string, AddressBookSyncRepairCandidate[]>();
  for (const candidate of parsedAuditCandidates) {
    const normalizedWid = normalizeAddressBookWid(candidate.wid);
    const existing = candidatesByWid.get(normalizedWid) ?? [];
    existing.push(candidate);
    candidatesByWid.set(normalizedWid, existing);
  }
  for (const [normalizedWid, auditedCandidates] of candidatesByWid) {
    const latestCandidate = auditedCandidates[0]!;
    const contact = knownContactsByWid.get(normalizedWid);
    if (!contact) {
      preliminaryResults.push(repairSkipped(latestCandidate, 'contact-not-found'));
      continue;
    }
    const matchingCandidate = auditedCandidates.find(
      (candidate) => contact.displayName?.trim() === candidate.oldContactName
    );
    if (!matchingCandidate) {
      preliminaryResults.push(repairSkipped(latestCandidate, 'contact-name-changed'));
      continue;
    }
    candidateByWid.set(normalizedWid, matchingCandidate);
  }
  return {
    candidates: [...candidateByWid.values()],
    preliminaryResults,
    nonPhoneFallbackCount
  };
}

export function planAddressBookSyncRepairs(input: {
  candidates: AddressBookSyncRepairCandidate[];
  preliminaryResults: AddressBookSyncRepairResult[];
  profiles: WhatsAppUserProfileNames[];
  dryRun: boolean;
}): { repairs: AddressBookSyncRepairPlanItem[]; results: AddressBookSyncRepairResult[] } {
  const profileByWid = new Map(
    input.profiles.map((profile) => [normalizeAddressBookWid(profile.wid), profile])
  );
  const repairs: AddressBookSyncRepairPlanItem[] = [];
  const results = [...input.preliminaryResults];
  for (const candidate of input.candidates) {
    const selectedName = selectAddressBookContactName(
      profileByWid.get(normalizeAddressBookWid(candidate.wid)),
      undefined
    );
    if (!selectedName) {
      results.push(repairSkipped(candidate, 'profile-name-unavailable'));
      continue;
    }
    const contactName = appendAddressBookSuffix(selectedName.value, candidate.suffix);
    if (contactName === candidate.oldContactName) {
      results.push(repairSkipped(candidate, 'already-correct'));
      continue;
    }
    if (!candidate.groupId || !candidate.sourceGroupWid) {
      results.push(repairSkipped(candidate, 'missing-group-context'));
      continue;
    }
    repairs.push({
      candidate: {
        ...candidate,
        groupId: candidate.groupId,
        sourceGroupWid: candidate.sourceGroupWid
      },
      contactName,
      nameSource: selectedName.source
    });
    results.push({
      auditId: candidate.auditId,
      wid: candidate.wid,
      oldContactName: candidate.oldContactName,
      status: input.dryRun ? 'would_repair' : 'repair_requested',
      contactName,
      nameSource: selectedName.source
    });
  }
  return { repairs, results };
}

export function historicalPhoneFallbackSuffix(contactName: string, wid: string): string | undefined {
  const normalizedWid = normalizeAddressBookWid(wid);
  const localPart = normalizedWid.split('@')[0] ?? '';
  if (!/^\d{7,15}$/.test(localPart)) return undefined;
  const bases = [wid.trim(), normalizedWid, `${localPart}@s.whatsapp.net`, `+${localPart}`, localPart]
    .sort((left, right) => right.length - left.length);
  for (const base of bases) {
    if (contactName === base) return '';
    if (contactName.startsWith(`${base} `)) {
      return contactName.slice(base.length).trim();
    }
  }
  return undefined;
}

export function normalizeAddressBookWid(wid: string): string {
  return wid.trim()
    .replace(/^([^:@]+):\d+@(lid|c\.us|s\.whatsapp\.net)$/i, '$1@$2')
    .replace(/@s\.whatsapp\.net$/i, '@c.us')
    .toLowerCase();
}

function repairSkipped(
  candidate: AddressBookSyncRepairCandidate,
  reason: AddressBookSyncRepairSkipReason
): AddressBookSyncRepairResult {
  return {
    auditId: candidate.auditId,
    wid: candidate.wid,
    oldContactName: candidate.oldContactName,
    status: 'skipped',
    reason
  };
}
