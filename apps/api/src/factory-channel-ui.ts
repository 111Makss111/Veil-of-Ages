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

@media (max-width: 650px) {
  .channel-dialog-shell { padding: 14px; }
}
`;
