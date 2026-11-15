// «Опыт и навыки»: то, что работодатель общепита смотрит первым. Ищу ли работу сейчас, выйду ли на пробную
// смену, где работал, что умею, санкнижка и район. Почти всё кнопками; какие навыки показать, решают
// профессии человека (skills.ts).
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { haptic } from '../platform';
import { ApiError, saveProfile, type Job, type JobTerm, type Med, type Profile, type ProfileView, type Skill } from '../server';
import type { Colors } from '../theme';
import type { Index, Lang } from '../types';
import { Button, Check, Chip, Field, styles as ui } from '../ui';
import { asksDriver, DISTRICTS, groupsFor, isLooking, JOB_TERMS, MED_OPTIONS, needsMed, skillLabel } from './skills';
import { P } from './texts';

const MAX_JOBS = 3;
const MAX_SKILLS = 12;

/** Место работы, пока его заполняют: срок ещё может быть не выбран. */
interface JobDraft {
  place: string;
  role: string;
  term: JobTerm | null;
  /** Должность вводят текстом, а не выбирают из своих профессий. */
  other: boolean;
}

const draftOf = (j: Job, roles: string[]): JobDraft => ({ ...j, other: !roles.includes(j.role) });
const empty = (j: JobDraft) => !j.place.trim() && !j.role.trim() && !j.term;
const complete = (j: JobDraft): j is JobDraft & { term: JobTerm } => !!j.place.trim() && !!j.role.trim() && !!j.term;

export function Work(props: { c: Colors; lang: Lang; index: Index | null; view: ProfileView; onSaved(v: ProfileView): void }) {
  const { c, lang, index, view, onSaved } = props;
  const t = P[lang];
  const profile = view.profile!;
  const [looking, setLooking] = useState(isLooking(profile.looking_at));
  const [trial, setTrial] = useState(!!profile.trial);
  const [jobs, setJobs] = useState<JobDraft[]>(() => (profile.jobs ?? []).map((j) => draftOf(j, profile.roles)));
  const [skills, setSkills] = useState<Skill[]>(profile.skills ?? []);
  const [med, setMed] = useState<Med | null>(profile.med ?? (profile.med_book ? 'yes' : null));
  const [driver, setDriver] = useState(profile.driver);
  const [district, setDistrict] = useState(profile.district);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const roleName = (title: string) => (lang === 'kk' ? index?.roles?.find((r) => r.title === title)?.title_kk ?? title : title);
  const groups = groupsFor(profile.roles, skills);
  const districts = DISTRICTS[profile.city] ?? [];

  const setJob = (i: number, patch: Partial<JobDraft>) => setJobs((list) => list.map((j, k) => (k === i ? { ...j, ...patch } : j)));
  const toggleSkill = (id: Skill) => {
    setError('');
    if (skills.includes(id)) return setSkills(skills.filter((x) => x !== id));
    if (skills.length >= MAX_SKILLS) return setError(t.skillsMax);
    haptic();
    setSkills([...skills, id]);
  };

  const save = async () => {
    const kept = jobs.filter((j) => !empty(j));
    if (!kept.every(complete)) return setError(t.jobIncomplete);
    setBusy(true);
    setError('');
    try {
      const next: Profile = {
        ...profile,
        jobs: kept.filter(complete).map((j) => ({ place: j.place.trim(), role: j.role.trim(), term: j.term })),
        skills,
        med,
        med_book: med === 'yes',
        driver,
        trial,
        looking,
        district: district || null,
      };
      onSaved(await saveProfile(next, lang));
    } catch (err) {
      setError(err instanceof ApiError && err.status >= 400 && err.status < 500 ? err.message : t.saveError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={ui.flex}>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Text style={[s.title, { color: c.ink }]}>{t.workTitle}</Text>
        <Text style={[s.text, { color: c.quiet }]}>{t.workHint}</Text>

        <Text style={[s.section, { color: c.ink }]}>{t.nowTitle}</Text>
        <Check c={c} checked={looking} label={t.looking} hint={t.lookingHint} onPress={() => setLooking(!looking)} />
        <Check c={c} checked={trial} label={t.trial} hint={t.trialHint} onPress={() => setTrial(!trial)} />

        <Text style={[s.section, { color: c.ink }]}>{t.jobsTitle}</Text>
        <Text style={[s.text, { color: c.quiet }]}>{t.jobsHint}</Text>
        {jobs.map((j, i) => (
          <View key={i} style={[s.card, { backgroundColor: c.card, borderColor: c.line }]}>
            <Field
              c={c}
              label={t.jobPlace}
              placeholder={t.jobPlaceHint}
              value={j.place}
              onChangeText={(place) => setJob(i, { place })}
              maxLength={60}
            />
            <Text style={[s.label, { color: c.quiet }]}>{t.jobRole}</Text>
            <View style={ui.row}>
              {profile.roles.map((r) => (
                <Chip key={r} c={c} active={!j.other && j.role === r} label={roleName(r)} onPress={() => setJob(i, { role: r, other: false })} />
              ))}
              <Chip c={c} active={j.other} label={t.jobRoleOther} onPress={() => setJob(i, { role: j.other ? j.role : '', other: true })} />
            </View>
            {j.other ? <Field c={c} placeholder={t.jobRoleOther} value={j.role} onChangeText={(role) => setJob(i, { role })} maxLength={60} /> : null}
            <Text style={[s.label, { color: c.quiet }]}>{t.jobTerm}</Text>
            <View style={ui.row}>
              {JOB_TERMS.map((term) => (
                <Chip key={term.value} c={c} active={j.term === term.value} label={term[lang]} onPress={() => setJob(i, { term: term.value })} />
              ))}
            </View>
            <View style={ui.row}>
              <Button c={c} small ghost label={t.jobRemove} onPress={() => setJobs(jobs.filter((_, k) => k !== i))} />
            </View>
          </View>
        ))}
        {jobs.length < MAX_JOBS ? (
          <Button c={c} ghost label={t.jobAdd} onPress={() => setJobs([...jobs, { place: '', role: profile.roles[0] ?? '', term: null, other: false }])} />
        ) : null}

        <Text style={[s.section, { color: c.ink }]}>{t.skillsTitle}</Text>
        {groups.length ? (
          <>
            <Text style={[s.text, { color: c.quiet }]}>{t.skillsHint}</Text>
            {groups.map((g) => (
              <View key={g.id} style={s.group}>
                <Text style={[s.label, { color: c.quiet }]}>{g.title[lang]}</Text>
                <View style={ui.row}>
                  {g.skills.map((id) => (
                    <Chip key={id} c={c} active={skills.includes(id)} label={skillLabel(id, lang)} onPress={() => toggleSkill(id)} />
                  ))}
                </View>
              </View>
            ))}
          </>
        ) : (
          <Text style={[s.text, { color: c.quiet }]}>{t.skillsNone}</Text>
        )}

        {needsMed(profile.roles) || med ? (
          <>
            <Text style={[s.section, { color: c.ink }]}>{t.medTitle}</Text>
            <View style={ui.row}>
              {MED_OPTIONS.map((o) => (
                <Chip key={o.value} c={c} big active={med === o.value} label={o[lang]} onPress={() => setMed(med === o.value ? null : o.value)} />
              ))}
            </View>
            <Text style={[s.text, { color: c.quiet }]}>{t.medHint}</Text>
          </>
        ) : null}

        {asksDriver(profile.roles) || driver ? <Check c={c} checked={driver} label={t.driver} onPress={() => setDriver(!driver)} /> : null}

        {districts.length ? (
          <>
            <Text style={[s.section, { color: c.ink }]}>{t.districtTitle}</Text>
            <Text style={[s.text, { color: c.quiet }]}>{t.districtHint}</Text>
            <View style={ui.row}>
              {districts.map((d) => (
                <Chip key={d} c={c} active={district === d} label={d} onPress={() => setDistrict(d)} />
              ))}
              <Chip c={c} active={!district} label={t.districtNone} onPress={() => setDistrict(null)} />
            </View>
          </>
        ) : null}
        {error ? <Text style={[s.error, { color: c.skip }]}>{error}</Text> : null}
      </ScrollView>
      <View style={s.foot}>
        <Button c={c} label={t.save} busy={busy} onPress={save} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  body: { padding: 16, gap: 12, paddingBottom: 32 },
  title: { fontSize: 26, fontWeight: '800' },
  text: { fontSize: 15, lineHeight: 21 },
  section: { fontSize: 17, fontWeight: '700', marginTop: 12 },
  label: { fontSize: 13 },
  card: { borderWidth: 1, borderRadius: 18, padding: 14, gap: 10 },
  group: { gap: 6 },
  error: { fontSize: 15, textAlign: 'center' },
  foot: { padding: 16, paddingTop: 8 },
});
