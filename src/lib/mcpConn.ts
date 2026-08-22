/**
 * mcpConn.ts — 本机 MCP server 接入信息的统一类型 + url 拼装。
 *
 * 单一真相源:Rust 端 `mcp_connection_info` Tauri command(见 src-tauri/src/mcp/connect.rs 的
 * `ConnectionInfo`)返回的就是这个结构 —— `{ port, token, command }`,**没有 url 字段**。
 *
 * 背景(4.3/4.4 复审 blocking bug):chatStore / CC / Codex 三处此前各自声明 `{ url, token }`
 * 并读 `conn?.url`,而该字段在真实返回里不存在 → url 永远 undefined → 传给 cli_agent_send 的
 * mcpUrl 为空 → 后端 claude.rs / codex.rs 据「有没有 url」决定是否注入 MCP,于是 MCP 从不注入,
 * CC/Codex 调不到 app 的工具、静默退化纯聊天。
 *
 * 修法:把「真实结构」与「url 拼装」收口到这一个文件,三处调用方共用,口径不再各写各的。
 * url 形态以后端约定为准:server 绑定 127.0.0.1:<port>,MCP 服务挂在 /mcp 路径下
 * (src-tauri/src/mcp/server.rs 的 `.nest_service("/mcp", service)` + `127.0.0.1:{MCP_PORT}`),
 * 与 connect.rs 拼 `command` 字段时用的 `http://127.0.0.1:{port}/mcp` 完全一致。
 */

/** 与 Rust 端 `mcp_connection_info` 返回逐字对齐(connect.rs::ConnectionInfo)。 */
export interface McpConnInfo {
  /** MCP server 监听端口(与后端 MCP_PORT 一致,当前 42800)。 */
  port: number;
  /** 接入密钥(Bearer token),持久化在 app config,重启不变。 */
  token: string;
  /** 现成的 `claude mcp add ...` 命令(含密钥),仅供 Settings 页一键复制;CLI 注入不用它。 */
  command: string;
}

/**
 * 据连接信息拼出 CLI 要连的 MCP HTTP url。
 *
 * 后端约定:streamable-http transport,server 在 127.0.0.1:<port>,服务路径 /mcp。
 * 这条 url 会原样传给 cli_agent_send 的 mcpUrl —— claude.rs 写进临时 mcp config 的 "url",
 * codex.rs 写进 `-c mcp_servers.latitude.url="<url>"`。
 *
 * @param conn 来自 `mcp_connection_info` 的返回;为 null(拿不到接入信息)时返回 undefined,
 *   调用方据此降级为纯聊天(不传 mcpUrl/mcpToken),与既有「拿不到 MCP 不报错」语义一致。
 */
export function mcpUrlFrom(conn: McpConnInfo | null | undefined): string | undefined {
  if (!conn) return undefined;
  return `http://127.0.0.1:${conn.port}/mcp`;
}
