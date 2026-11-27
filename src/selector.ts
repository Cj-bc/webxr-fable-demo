/** 1 つのグループに属する候補と、現在の選択を公開する。 */
export interface ISelector<T> {
  readonly list: readonly T[];
  readonly active: T | null;
  /** グループ内の候補を選択する。 */
  setActive(item: T): void;
  /** 候補の一覧または選択状態の更新を購読する。 */
  onChange(listener: () => void): void;
}
