// One verified message from the personal connector. Display names cannot establish authorship.
export interface PersonalAiMessage {
  messageId: string;
  chatId: string;
  senderId: string;
  senderIdType: string;
  text: string;
  createdAt: string;
  kind: 'direct' | 'group';
  threadId?: string;
  rootId?: string;
  groupUserCount?: number;
  groupObserved?: boolean;
}
