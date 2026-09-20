// Швидке налаштування: змініть лише це значення, щоб змінити ширину й висоту картки каналу.
export const CHANNEL_CARD_SIZE = '100px';

export const factoryChannelCss = `
.channel-picker {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding: 4px 2px 14px;
  margin: 18px 0 4px;
}

.channel-picker .channel-tile {
  position: relative;
  flex: 0 0 ${CHANNEL_CARD_SIZE};
  width: ${CHANNEL_CARD_SIZE};
  height: ${CHANNEL_CARD_SIZE};
  min-width: ${CHANNEL_CARD_SIZE};
  padding: 9px 7px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-end;
  gap: 2px;
  overflow: hidden;
  text-align: left;
  color: #dff1d2;
  background:
    linear-gradient(180deg, transparent 28%, #08110dda 72%),
    radial-gradient(circle at 68% 22%, #7ca45b55, transparent 35%),
    #14251a;
  border: 1px solid #bde99855;
  border-radius: 11px;
  box-shadow: inset 0 0 28px #8abb6510;
}

.channel-picker .channel-tile:hover {
  transform: translateY(-2px);
  background:
    linear-gradient(180deg, transparent 28%, #08110de8 72%),
    radial-gradient(circle at 68% 22%, #91bd6a66, transparent 35%),
    #17291d;
}

.channel-picker .channel-tile i {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #9fe675;
  box-shadow: 0 0 11px #9fe675;
}

.channel-picker .channel-tile-mark {
  position: absolute;
  top: 10px;
  left: 9px;
  font: 17px Georgia, serif;
  color: #c9e6a8;
}

.channel-picker .channel-tile-name {
  width: 100%;
  font-size: 9px;
  line-height: 1.15;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.channel-picker .channel-tile-style,
.channel-picker .channel-tile-meta {
  width: 100%;
  font-size: 7px;
  line-height: 1.15;
  color: #91aa86;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.channel-picker .channel-tile-youtube { color: #a9d789; }
.channel-picker .channel-tile-youtube.warning { color: #d2b170; }

.channel-dialog {
  width: min(1100px, calc(100% - 30px));
  max-height: calc(100vh - 30px);
  overflow: auto;
  color: #e9eee5;
  background: #0b1710;
  border: 1px solid #c0dba340;
  border-radius: 18px;
  padding: 0;
  box-shadow: 0 30px 100px #000c;
}

.channel-dialog::backdrop {
  background: #020806d9;
  backdrop-filter: blur(7px);
}

.channel-dialog-shell { padding: 24px; }
.channel-dialog-shell > .row { margin-bottom: 4px; }
.channel-dialog-shell > .row h2 { margin: 6px 0; }
.channel-dialog-shell > .row .eyebrow { margin: 0; }
.channel-dialog .panel { margin-bottom: 0; }

.container-fieldset {
  margin: 20px 0 24px;
  padding: 0;
  border: 0;
}

.container-fieldset legend {
  color: #c0d1b4;
  font-size: 13px;
}

.container-fieldset .hint { margin: 7px 0 12px; }

.container-choices {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.container-choice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 55px;
  margin: 0;
  padding: 10px;
  background: #09140d;
  border: 1px solid #c2d8a825;
  border-radius: 9px;
  cursor: pointer;
}

.container-choice:has(input:checked) {
  border-color: #bde99870;
  background: #bfe9960d;
}

.container-choice input {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 2px 0 0;
  accent-color: #bde998;
}

.container-choice span,
.container-choice strong,
.container-choice small { display: block; }
.container-choice strong { font-size: 11px; line-height: 1.25; }
.container-choice small { margin-top: 4px; font-size: 9px; line-height: 1.35; }

.line-channel {
  max-width: 420px;
  margin: 16px 0 4px;
}

textarea {
  display: block;
  width: 100%;
  resize: vertical;
  font: inherit;
  line-height: 1.55;
  color: #e4eddd;
  background: #09140d;
  border: 1px solid #c2d8a832;
  border-radius: 9px;
  padding: 13px;
  margin-top: 9px;
}

.steps-six { grid-template-columns: repeat(6, 1fr); }
.steps-seven { grid-template-columns: repeat(7, 1fr); }
.idea-form, .idea-workspace { max-width: 1040px; }
.idea-workspace h2 { font: 500 clamp(27px, 4vw, 42px) Georgia, serif; color: #eaf4e3; margin-bottom: 8px; }
.idea-workspace h3 { margin: 22px 0 8px; color: #dcebd2; }
.idea-copy { white-space: pre-wrap; max-height: 360px; overflow: auto; padding: 18px; border-radius: 11px; background: #08120c; border: 1px solid #c2e59f1c; color: #bccdb2; line-height: 1.65; }
.idea-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
.idea-upload { padding-top: 18px; margin-top: 20px; border-top: 1px solid #c6eba71d; }
.idea-upload input { max-width: 560px; }
.release-thumbnail { display:block; width:min(100%,640px); aspect-ratio:16/9; object-fit:cover; margin:18px 0 5px; border-radius:10px; border:1px solid #c6eba724; }
.release-details { margin: 0; }
.release-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
  list-style: none;
  cursor: pointer;
}
.release-summary::-webkit-details-marker { display: none; }
.release-summary-info { min-width: 0; }
.release-summary-info h3 { margin: 0 0 7px; }
.release-summary-info p { margin: 0; color: #8fa285; }
.release-summary-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.release-toggle {
  min-width: 92px;
  padding: 9px 13px;
  color: #dff2cf;
  background: #bde9980d;
  border: 1px solid #bde9983d;
  border-radius: 9px;
  text-align: center;
  font-size: 11px;
  font-weight: 650;
}
.release-summary:hover .release-toggle { background: #bde99818; border-color: #bde99866; }
.release-body { margin-top: 18px; padding-top: 18px; border-top: 1px solid #c6eba71d; }
.release-body > :first-child { margin-top: 0; }
.batch-launch { max-width: 1040px; }
.batch-launch > summary { color: #a8bb9e; }
.batch-launch .hero { margin-bottom: 0; }

.short-prompts { margin: 10px 0 14px; }
.short-prompts > summary {
  color: #82967a;
  font-size: 10px;
  letter-spacing: .04em;
}
.short-prompt-list { display: grid; gap: 5px; margin-top: 9px; }
.short-prompt-row {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  color: #9eb092;
  background: #0a150e;
  border: 1px solid #c2e59f14;
  border-radius: 7px;
  font-size: 10px;
}
.short-prompt-row button,
.short-copy-all { min-width: 0; padding: 5px 8px; font-size: 9px; }
.short-prompt-row details { margin: 0; }
.short-prompt-row details > summary { font-size: 9px; color: #71836b; }
.short-prompt-row details small { display: block; grid-column: 1 / -1; margin-top: 8px; white-space: pre-wrap; }
.short-copy-all { margin-top: 9px; }
.short-batch-label { margin-top: 18px; }
.short-batch-label input { margin-top: 8px; }
.shorts-workspace { max-width: 1040px; border-color: #bde99845; }
.shorts-workspace[hidden] { display: none; }
.shorts-timing { display: grid; grid-template-columns: minmax(220px,.9fr) minmax(260px,1.1fr); gap: 16px; align-items: center; margin-top: 18px; padding: 18px; border: 1px solid #bde99838; border-radius: 11px; background: #09140d; }
.shorts-timing h3 { margin: 5px 0 8px; }
.shorts-timing audio { width: 100%; }
.shorts-timing-controls { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(260px,1fr) auto auto; gap: 12px; align-items: center; }
.shorts-window { position: relative; height: 62px; min-width: 0; }
.shorts-window-track { position: absolute; inset: 28px 4px auto; height: 8px; border-radius: 99px; background: #2b352e; box-shadow: inset 0 0 0 1px #d9f4be1e; }
.shorts-window-selection { position: absolute; top: 0; bottom: 0; border-radius: inherit; background: linear-gradient(90deg,#bde998,#e3ca73); box-shadow: 0 0 16px #bde99845; pointer-events: none; }
.shorts-window-marker { position: absolute; top: -23px; transform: translateX(-50%); color: #d9f4be; font-size: 9px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; white-space: nowrap; pointer-events: none; }
.shorts-window-marker::after { content: ''; display: block; width: 3px; height: 30px; margin: 5px auto 0; border-radius: 3px; background: currentColor; box-shadow: 0 0 10px #bde99888; }
.shorts-window-marker.end { color: #e3ca73; }
.shorts-window input[type="range"] { position: absolute; inset: 8px 0 0; z-index: 3; width: 100%; height: 48px; margin: 0; opacity: .01; cursor: ew-resize; }
.shorts-timing-controls strong { min-width: 92px; color: #d9f4be; font-variant-numeric: tabular-nums; }
.shorts-timing-controls button.confirmed { border-color: #bde998; background: #274329; }
.shorts-time-status { grid-column: 1 / -1; color: #91a987; font-size: 10px; }
.shorts-mode-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
.shorts-mode { padding: 18px; border: 1px solid #c2e59f24; border-radius: 11px; background: #09140d; }
.shorts-mode h3 { margin: 5px 0 8px; }
.shorts-mode p { min-height: 58px; color: #93a78a; }
.shorts-mode.recommended { border-color: #bde99865; background: linear-gradient(135deg,#102017,#0a150e); }
.shorts-mapping { display: grid; gap: 6px; margin: 12px 0; }
.shorts-mapping div { display: grid; grid-template-columns: 28px minmax(120px,.7fr) 1fr; gap: 8px; padding: 7px 9px; border-radius: 7px; background: #0a150e; color: #9fb394; font-size: 10px; }
.shorts-production { margin: 16px 0; }
.shorts-production.waiting { border-color: #d6b56955; }
.shorts-production.waiting .progress-fill { background: linear-gradient(90deg,#8b6b43,#d9c174); animation: shorts-wait 1.8s ease-in-out infinite; }
.shorts-production-steps { grid-template-columns: repeat(7,minmax(0,1fr)); }
@keyframes shorts-wait { 50% { filter: brightness(1.25); box-shadow: 0 0 24px #d9c17470; } }
.shorts-workspace video.shorts-preview { width: min(100%,360px); aspect-ratio: 9/16; object-fit: contain; background: #000; }

@media (max-width: 650px) {
  .channel-dialog-shell { padding: 14px; }
  .container-choices { grid-template-columns: 1fr; }
  .steps-six { grid-template-columns: 1fr 1fr; }
  .steps-seven { grid-template-columns: 1fr 1fr; }
  .shorts-mode-grid { grid-template-columns: 1fr; }
  .shorts-timing { grid-template-columns: 1fr; }
  .shorts-timing-controls { grid-template-columns: 1fr; }
  .shorts-time-status { grid-column: auto; }
  .release-summary { grid-template-columns: 1fr; gap: 12px; }
  .release-summary-actions { justify-content: space-between; }
  .short-prompt-row { grid-template-columns: 1fr auto; }
  .short-prompt-row details { grid-column: 1 / -1; }
  .shorts-production-steps { grid-template-columns: 1fr; }
}
`;
