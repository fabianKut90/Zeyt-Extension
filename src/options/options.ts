import { getConfig, clearPairing } from '../storage';

const $ = (id: string) => document.getElementById(id)!;

async function init(): Promise<void> {
  const config = await getConfig();

  $('device-id').textContent = config.extensionDeviceId;

  if (config.groupId) {
    $('pairing-state').textContent = `Linked — group: ${config.groupId.slice(0, 8)}…`;
    ($('btn-unpair') as HTMLButtonElement).disabled = false;
  } else {
    $('pairing-state').textContent = 'Not linked to any phone app.';
    ($('btn-unpair') as HTMLButtonElement).disabled = true;
  }
}

$('btn-unpair').addEventListener('click', async () => {
  const confirmed = confirm(
    'This will unlink your phone app. You will need to scan a new QR code to reconnect. Continue?',
  );
  if (!confirmed) return;

  await clearPairing();
  await chrome.runtime.sendMessage({ type: 'UNPAIR' });
  $('pairing-state').textContent = 'Not linked to any phone app.';
  ($('btn-unpair') as HTMLButtonElement).disabled = true;
});

init();
