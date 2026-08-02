function escapeCommandData(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeCommandProperty(value) {
  return escapeCommandData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

export default async function* githubActionsTestReporter(source) {
  for await (const event of source) {
    if (event.type !== "test:fail") continue;

    const { name = "Node.js test failure", file, line, column, details } = event.data ?? {};
    const error = details?.error;
    const message = error?.stack || error?.message || `Test failed: ${name}`;
    const properties = [`title=${escapeCommandProperty(name)}`];
    if (file) properties.push(`file=${escapeCommandProperty(file)}`);
    if (Number.isInteger(line)) properties.push(`line=${line}`);
    if (Number.isInteger(column)) properties.push(`col=${column}`);
    yield `::error ${properties.join(",")}::${escapeCommandData(message)}\n`;
  }
}
