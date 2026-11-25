// 操作の実装のひな形。_ で始まるファイルは読み込まれないので、コピーして名前を変えて使う。
// ファイル名は `<ideas.md の ID 小文字>-<内容>.ts` (例: d1-shrink.ts)。
import type { InteractionFactory } from '../types';

const create: InteractionFactory = (ctx) => {
  // 例: 持っている物を、もう一方の手で握ると消す。
  ctx.addGrabInterceptor((hand, item) => {
    const other = ctx.app.input.other(hand);
    if (!ctx.items.heldBy(other).includes(item)) return false;
    ctx.audio.click(item.object.position);
    ctx.items.remove(item);
    return true;
  });

  return {
    id: 'X0',
    label: '例',
    category: 'delete',
  };
};

export default create;
