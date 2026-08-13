export class CommandRegistry {
  #commands = new Map();

  register(command) {
    if (!command?.id || typeof command.execute !== 'function') throw new Error('Command requires id and execute()');
    this.#commands.set(command.id, {
      title: command.id,
      category: 'General',
      keywords: [],
      ...command
    });
    return () => this.#commands.delete(command.id);
  }

  get(id) { return this.#commands.get(id) || null; }
  list(context = null) {
    return [...this.#commands.values()].filter((command) => {
      try { return command.isAvailable ? command.isAvailable(context) !== false : true; }
      catch { return false; }
    });
  }

  async execute(id, context, ...args) {
    const command = this.get(id);
    if (!command) throw new Error(`Unknown command: ${id}`);
    if (command.isAvailable && command.isAvailable(context) === false) return false;
    await command.execute(context, ...args);
    return true;
  }
}

export function fuzzyScore(query, value) {
  const q = String(query || '').trim().toLowerCase();
  const text = String(value || '').toLowerCase();
  if (!q) return 1;
  if (text === q) return 10000;
  const direct = text.indexOf(q);
  if (direct >= 0) return 5000 - direct * 4 - Math.max(0, text.length - q.length);
  let cursor = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const at = text.indexOf(ch, cursor);
    if (at < 0) return -1;
    if (at === cursor) { streak += 1; score += 20 + streak * 8; }
    else { streak = 0; score += Math.max(1, 8 - (at - cursor)); }
    cursor = at + 1;
  }
  return score - Math.max(0, text.length - q.length) * 0.1;
}

export function rankCommands(commands, query) {
  return commands
    .map((command) => {
      const haystack = [command.title, command.id, command.category, ...(command.keywords || [])].join(' ');
      return { command, score: fuzzyScore(query, haystack) };
    })
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title));
}

export function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}
