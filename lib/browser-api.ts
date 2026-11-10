/** Do not replace an HTTP error with an unrelated JSON parsing exception. */
export async function responseJson(response: Response): Promise<any> {
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? "The local server returned unreadable data. Refresh the app."
        : `Request failed (HTTP ${response.status}). The local server did not return JSON error details.`,
    );
  }
  if (!response.ok)
    throw new Error(
      typeof data?.error === "string"
        ? data.error
        : `Request failed (HTTP ${response.status}).`,
    );
  return data;
}
export async function requestJson(path: string, options?: RequestInit) {
  return responseJson(await fetch(path, options));
}
