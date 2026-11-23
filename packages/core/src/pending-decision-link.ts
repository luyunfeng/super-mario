const routes = { inbox: '#chat?inbox=', approvals: '#chat?approval=', interactions: '#chat?interaction=', plans: '#chat?plan=', mailboxes: '#chat?mailbox=', conversations: '#inbox?conversation=' };

export function pendingDecisionHref(collection: keyof typeof routes, id: string) {
  return routes[collection] + encodeURIComponent(id);
}
