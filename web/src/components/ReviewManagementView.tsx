import { liveText } from '@/i18n/liveText';
import { t, useLocale } from '@/i18n';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  DatePicker,
  Empty,
  Input,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import type { Application } from '@/types/application';
import type { CreateNoteInput, InterviewNote } from '@/types/note';
import { createStandaloneNote, deleteNote, listNotes, updateNote } from '@/services/notes';
import ReviewFormDrawer from '@/components/ReviewFormDrawer';
import InterviewReviewProposalDrawer, {
  type InterviewReviewProposalAttemptState,
} from '@/components/InterviewReviewProposalDrawer';
import InterviewKnowledgeCaptureDrawer, {
  createInterviewKnowledgeCaptureDraft,
  type InterviewKnowledgeCaptureDraft,
} from '@/components/InterviewKnowledgeCaptureDrawer';

const { Text, Paragraph } = Typography;

const MOOD_OPTIONS = [
  { value: 'good', get label() { return t("好"); } },
  { value: 'normal', get label() { return t("一般"); } },
  { value: 'bad', get label() { return t("差"); } },
];

interface Props {
  applications: Application[];
  interviewReviewProposalAttempts?: Record<number, InterviewReviewProposalAttemptState>;
  onInterviewReviewProposalAttemptChange?: (
    noteID: number,
    state: InterviewReviewProposalAttemptState | null,
  ) => void;
  onInterviewNoteChanged?: (noteID: number) => void;
  interviewKnowledgeCaptureDrafts?: Record<number, InterviewKnowledgeCaptureDraft>;
  onInterviewKnowledgeCaptureDraftChange?: (noteID: number, draft: InterviewKnowledgeCaptureDraft | null) => void;
  onInterviewKnowledgeCaptureNoteChanged?: (noteID: number) => void;
}

function includesText(value: string | undefined, query: string) {
  return (value ?? '').toLowerCase().includes(query);
}

function inDateRange(date: string, range: [Dayjs | null, Dayjs | null] | null) {
  if (!range?.[0] || !range?.[1]) return true;
  if (!date) return false;

  const parsed = dayjs(date);
  if (!parsed.isValid()) return false;

  return !parsed.isBefore(range[0], 'day') && !parsed.isAfter(range[1], 'day');
}

export default function ReviewManagementView({ applications, interviewReviewProposalAttempts, onInterviewReviewProposalAttemptChange, onInterviewNoteChanged, interviewKnowledgeCaptureDrafts, onInterviewKnowledgeCaptureDraftChange, onInterviewKnowledgeCaptureNoteChanged }: Props) {
  useLocale();
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<InterviewNote | null>(null);
  const [proposalNote, setProposalNote] = useState<InterviewNote | null>(null);
  const [knowledgeCaptureNote, setKnowledgeCaptureNote] = useState<InterviewNote | null>(null);
  const [search, setSearch] = useState('');
  const [applicationID, setApplicationID] = useState<number | undefined>();
  const [mood, setMood] = useState<string | undefined>();
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);

  const notesQuery = useQuery({
    queryKey: ['notes', 'all'],
    queryFn: listNotes,
  });

  const invalidateNotes = () => queryClient.invalidateQueries({ queryKey: ['notes'] });

  const createMut = useMutation({
    mutationFn: createStandaloneNote,
    onSuccess: () => {
      message.success(liveText(() => t("已保存面试复盘")));
      setDrawerOpen(false);
      invalidateNotes();
    },
    onError: () => message.error(liveText(() => t("保存失败"))),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, input }: { id: number; input: CreateNoteInput }) => updateNote(id, input),
    onSuccess: (_data, variables) => {
      onInterviewNoteChanged?.(variables.id);
      onInterviewKnowledgeCaptureNoteChanged?.(variables.id);
      message.success(liveText(() => t("已更新面试复盘")));
      setEditing(null);
      setDrawerOpen(false);
      invalidateNotes();
    },
    onError: () => message.error(liveText(() => t("更新失败"))),
  });

  const deleteMut = useMutation({
    mutationFn: deleteNote,
    onSuccess: () => {
      message.success(liveText(() => t("已删除面试复盘")));
      invalidateNotes();
    },
    onError: () => message.error(liveText(() => t("删除失败"))),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (notesQuery.data ?? []).filter((note) => {
      if (applicationID && note.application_id !== applicationID) return false;
      if (mood && note.mood !== mood) return false;
      if (!inDateRange(note.date, dateRange)) return false;
      if (!q) return true;

      return (
        includesText(note.company, q) ||
        includesText(note.position, q) ||
        includesText(note.round, q) ||
        includesText(note.questions, q) ||
        includesText(note.self_reflection, q) ||
        includesText(note.difficulty_points, q)
      );
    });
  }, [notesQuery.data, search, applicationID, mood, dateRange]);

  function openCreate() {
    setEditing(null);
    setDrawerOpen(true);
  }

  function handleSubmit(input: CreateNoteInput) {
    if (editing) {
      updateMut.mutate({ id: editing.id, input });
    } else {
      createMut.mutate(input);
    }
  }

  if (proposalNote) {
    return (
      <InterviewReviewProposalDrawer
        open
        note={proposalNote}
        eventID={proposalNote.application_event_id}
        attemptState={interviewReviewProposalAttempts?.[proposalNote.id]}
        onAttemptStateChange={(state) => onInterviewReviewProposalAttemptChange?.(proposalNote.id, state)}
        onClose={() => setProposalNote(null)}
      />
    );
  }

  if (knowledgeCaptureNote) {
    const note = knowledgeCaptureNote;
    return (
      <InterviewKnowledgeCaptureDrawer
        open
        note={note}
        draft={interviewKnowledgeCaptureDrafts?.[note.id] ?? createInterviewKnowledgeCaptureDraft()}
        onDraftChange={(draft) => onInterviewKnowledgeCaptureDraftChange?.(note.id, draft)}
        onClose={() => setKnowledgeCaptureNote(null)}
      />
    );
  }

  if (drawerOpen) {
    return (
      <ReviewFormDrawer
        open={drawerOpen}
        applications={applications}
        note={editing}
        saving={createMut.isPending || updateMut.isPending}
        onSubmit={handleSubmit}
        onClose={() => {
          setDrawerOpen(false);
          setEditing(null);
        }}
      />
    );
  }

  return (
    <div>
      <Space style={{ marginBottom: 16, width: '100%', alignItems: 'center' }} wrap>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t("新建复盘")}</Button>
        <Input.Search
          allowClear
          placeholder={t("搜索公司、岗位、问题、反思")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 320 }}
        />
        <Select
          allowClear
          showSearch
          placeholder={t("按投递筛选")}
          optionFilterProp="label"
          value={applicationID}
          onChange={setApplicationID}
          style={{ width: 240 }}
          options={applications.map((app) => ({
            value: app.id,
            label: `${app.company_name} / ${app.position_name}`,
          }))}
        />
        <Select
          allowClear
          placeholder={t("按心情筛选")}
          value={mood}
          onChange={setMood}
          style={{ width: 140 }}
          options={MOOD_OPTIONS.map((option) => ({ ...option }))}
        />
        <DatePicker.RangePicker
          value={dateRange}
          onChange={(value) => setDateRange(value)}
          style={{ width: 260 }}
        />
      </Space>

      {notesQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : filtered.length === 0 ? (
        <Empty description={notesQuery.data?.length ? t("没有匹配的复盘") : t("还没有面试复盘")} />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {filtered.map((note) => (
            <Card
              key={note.id}
              size="small"
              title={t("{company} / {position} / {round}", { company: note.company, position: note.position || t('未填写岗位'), round: note.round || t('未标注轮次') })}
              extra={
                <Space>
                  {note.date && <Text type="secondary">{note.date}</Text>}
                  {note.mood && <Tag color="green">{note.mood}</Tag>}
                  <Tooltip title={t("编辑")}>
                    <Button
                      type="text"
                      icon={<EditOutlined />}
                      onClick={() => {
                        setEditing(note);
                        setDrawerOpen(true);
                      }}
                    />
                  </Tooltip>
                  <Button type="text" size="small" onClick={() => {
                    onInterviewKnowledgeCaptureDraftChange?.(
                      note.id,
                      interviewKnowledgeCaptureDrafts?.[note.id] ?? createInterviewKnowledgeCaptureDraft(),
                    );
                    setKnowledgeCaptureNote(note);
                  }}>
                    {t("保存为复盘沉淀")}</Button>
                  <Tooltip title={t("删除")}>
                    <Button type="text" onClick={() => setProposalNote(note)}>
                      {t("复盘建议")}</Button>
                    <Popconfirm
                      title={t("删除这条复盘？")}
                      onConfirm={() => deleteMut.mutate(note.id)}
                      okText={t("删除")}
                      cancelText={t("取消")}
                    >
                      <Button type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Tooltip>
                </Space>
              }
            >
              {note.questions && <Paragraph ellipsis={{ rows: 2 }}>{t("问题：")}{note.questions}</Paragraph>}
              {note.self_reflection && <Paragraph ellipsis={{ rows: 2 }}>{t("反思：")}{note.self_reflection}</Paragraph>}
              {note.difficulty_points && <Paragraph ellipsis={{ rows: 2 }}>{t("难点：")}{note.difficulty_points}</Paragraph>}
            </Card>
          ))}
        </Space>
      )}

    </div>
  );
}
