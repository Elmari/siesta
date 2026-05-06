import keytar from 'keytar';

const SERVICE = 'siesta';

export async function getPassword(username: string): Promise<string | null> {
  return keytar.getPassword(SERVICE, username);
}

export async function setPassword(username: string, password: string): Promise<void> {
  await keytar.setPassword(SERVICE, username, password);
}

export async function deletePassword(username: string): Promise<boolean> {
  return keytar.deletePassword(SERVICE, username);
}
