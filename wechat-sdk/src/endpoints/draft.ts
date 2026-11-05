export interface DraftArticleInput {
  article_type?: 'news';
  title: string;                 // <= 32 字符
  author?: string;               // <= 16 字符
  digest?: string;               // <= 120 字符
  content: string;               // HTML, < 1MB & 纯文本 < 20,000 字
  content_source_url?: string;   // 原文链接
  thumb_media_id: string;        // 必填，永久图片素材 media_id
  need_open_comment?: 0 | 1;
  only_fans_can_comment?: 0 | 1;
}

export interface DraftCountResult {
  total_count: number;
}

export interface DraftAddResult {
  media_id: string;
}

export interface DraftArticleDetail extends DraftArticleInput {
  url?: string;
}

export interface DraftGetResult {
  news_item: DraftArticleDetail[];
}

export interface DraftBatchGetItem {
  media_id: string;
  update_time: number;
  content: {
    news_item: DraftArticleDetail[];
  };
}

export interface DraftBatchGetResult {
  total_count: number;
  item_count: number;
  item: DraftBatchGetItem[];
}

export interface MaterialBatchGetItem {
  media_id: string;
  name?: string;
  update_time: number;
  url?: string;
}

export interface MaterialBatchGetResult {
  total_count: number;
  item_count: number;
  item: MaterialBatchGetItem[];
}

export interface PublishSubmitResult {
  publish_id: string;
  msg_data_id?: string;
}

export interface PublishStatusResult {
  publish_id: string;
  publish_status: number; // 0:成功, 1:发布中, 2+:失败
  article_id?: string;
  fail_idx?: number[];
}
