import { useEffect, useState } from 'react';
import { Button, Image } from 'antd';
import { readChatImage, type ChatImageReference } from '@/services/chatImages';
import styles from './ChatPanel.module.css';

/** Fetch through the authenticated client; credentials never enter image URLs. */
export default function ChatImagePreview({ image, localUrl, onReference, label = '消息图片' }: {
  image?: ChatImageReference; localUrl?: string; onReference?: () => void; label?: string;
}) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (localUrl || !image) return;
    let active = true;
    let objectUrl: string | undefined;
    setFailed(false);
    setUrl(undefined);
    void readChatImage(image.id).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [image?.id, localUrl, attempt]);
  return <div className={styles.imagePreview}>
    <span>{label}</span>
    {localUrl || url ? <Image src={localUrl ?? url} width={88} height={72} style={{ objectFit: 'cover' }} alt={`${label}，点击放大`} />
      : failed ? <Button size="small" onClick={() => setAttempt((value) => value + 1)}>重新加载图片</Button>
        : <span role="status">加载图片…</span>}
    {onReference ? <Button size="small" type="text" onClick={onReference}>再次引用</Button> : null}
  </div>;
}
