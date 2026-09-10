export function workArea(pane: HTMLElement) {
  const dock = document.querySelector<HTMLElement>('.desktop-dock')
  return { deskW: pane.clientWidth, deskH: Math.max(1, pane.clientHeight - (dock ? dock.offsetHeight + 18 : 0)) }
}
