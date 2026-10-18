// Appended to the shared full-page fixture by test-generated-ui.mjs. These
// cases execute the actual minified Rust operator assets without a device.
async function textFixture(options = {}) {
  const app = fixture(serverRuntimeVersion, options);
  await flush(); app.frame(); await flush();
  return app;
}

test("Rust text button sends Chinese and mixed Unicode unchanged once", async () => {
  const app = await textFixture();
  try {
    const value = "中文，Hello 🙂\n第二行";
    app.element("typing-input").value = value;
    app.click("type-button"); await flush();
    const calls = app.calls.filter(({ name }) => name === "android_type");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.text, value);
    assert.equal(app.element("error-box").hidden, true);
    app.frame(); await flush();
    assert.equal(app.calls.filter(({ name }) => name === "android_type").length, 1);
  } finally { await app.close(); }
});

test("Rust text validation uses UTF-8 bytes and rejects invalid strings before ARM", async () => {
  for (const value of ["", "中\0文", "中".repeat(171), "🙂".repeat(129), "中\ud800", "\udc00文", "\x01"]) {
    const app = await textFixture();
    try {
      app.element("typing-input").value = value;
      app.click("type-button"); await flush();
      assert.equal(app.calls.filter(({ name }) => ["android_type", "android_hid_arm"].includes(name)).length, 0);
      assert.equal(app.element("error-box").hidden, false);
      assert.match(app.element("error-message").textContent, /输入|文字|字符/u);
    } finally { await app.close(); }
  }
  for (const value of ["中".repeat(170) + "ab", "🙂".repeat(128), "English 123\t\n"]) {
    const app = await textFixture();
    try {
      app.element("typing-input").value = value;
      app.click("type-button"); await flush();
      assert.equal(app.calls.filter(({ name }) => name === "android_type").length, 1);
    } finally { await app.close(); }
  }
});

test("Rust Chinese submission stays single while a result is delayed", async () => {
  const pending = deferred();
  const app = await textFixture({ typeResponse: () => pending.promise });
  try {
    app.element("typing-input").value = "只发送一次";
    app.click("type-button"); await flush();
    assert.equal(app.element("type-button").disabled, true);
    app.click("type-button"); await flush();
    assert.equal(app.calls.filter(({ name }) => name === "android_type").length, 1);
    pending.resolve({ content: [], structuredContent: { textTransfer: { status: "accepted" } } });
    await flush();
    assert.equal(app.calls.filter(({ name }) => name === "android_type").length, 1);
  } finally { pending.resolve({ content: [] }); await app.close(); }
});

test("Rust Chinese setup failures explain IME selection and focus without replaying text", async () => {
  for (const message of [
    "TEXT_IME_NOT_READY: Enable/select the device IME and focus an editable field; no text was sent.",
    "TEXT_IME_UNAVAILABLE: Update the phone App and select its IME; no text was sent.",
    "Phone Unicode IME is not ready. Enable/select it and focus an editable field; no text was sent.",
    "Unicode input unavailable: update the ESP/App and enable/select the QDD phone IME, then focus an editable field. No text was sent.",
  ]) {
    const app = await textFixture({ typeResponse: () => ({ isError: true, content: [{ type: "text", text: message }] }) });
    try {
      app.element("typing-input").value = "中文";
      app.click("type-button"); await flush();
      assert.equal(app.calls.filter(({ name }) => name === "android_type").length, 1);
      assert.match(app.element("error-message").textContent, /投屏/u);
      assert.match(app.element("error-message").textContent, /选择当前控制器/u);
      assert.match(app.element("error-message").textContent, /启用并选中/u);
      assert.match(app.element("error-message").textContent, /设备中文输入/u);
      assert.doesNotMatch(app.element("error-message").textContent, /剪贴板|无障碍|保持投屏/u);
      assert.match(app.element("error-message").textContent, /输入框/u);
      assert.equal(app.element("typing-input").value, "中文");
      app.frame(); await flush();
      assert.equal(app.calls.filter(({ name }) => name === "android_type").length, 1);
      assert.doesNotMatch(app.element("activity").textContent, /发送文字已发送/u);
    } finally { await app.close(); }
  }
});

test("Rust screen TIMEOUT and MIME errors are not mistaken for phone IME setup", async () => {
  for (const message of ["SCREEN_TIMEOUT: 还没有收到手机画面，请检查投屏。", "SCREEN_HTTP_ERROR: 手机连续流的 MIME 类型不正确。 "]) {
    const app = await textFixture({ typeResponse: () => ({ isError: true, content: [{ type: "text", text: message }] }) });
    try {
      app.element("typing-input").value = "中文";
      app.click("type-button"); await flush();
      assert.doesNotMatch(app.element("error-message").textContent, /设备中文输入/u);
      assert.equal(app.calls.filter(({ name }) => name === "android_type").length, 1);
    } finally { await app.close(); }
  }
});

test("Rust uncertain Chinese delivery remains visible and never suggests resending", async () => {
  const app = await textFixture({ typeResponse: () => ({ isError: true,
    content: [{ type: "text", text: "HID operation cancelled. Transfer 0000000000000001; delivery is uncertain: observe the phone and never blindly resubmit. Text/COMMIT was not retried." }],
    structuredContent: { textTransfer: { status: "uncertain", automaticallyRetried: false, retrySafe: false } },
  }) });
  try {
    app.element("typing-input").value = "可能已输入";
    app.click("type-button"); await flush();
    assert.match(app.element("error-message").textContent, /可能已输入/u);
    assert.match(app.element("error-message").textContent, /不要重复发送/u);
    assert.equal(app.element("typing-input").value, "可能已输入");
    app.frame(); await flush();
    assert.equal(app.calls.filter(({ name }) => name === "android_type").length, 1);
    assert.doesNotMatch(app.element("activity").textContent, /发送文字已发送/u);
  } finally { await app.close(); }
});

test("Rust IME rejection identifies refused text without replaying", async () => {
  const app = await textFixture({ typeResponse: () => ({ isError: true,
    content: [{ type: "text", text: "TEXT_IME_REJECTED: The phone IME explicitly rejected the text." }],
  }) });
  try {
    app.element("typing-input").value = "文字被拒绝";
    app.click("type-button"); await flush();
    assert.match(app.element("error-message").textContent, /输入框未接受/u);
    assert.match(app.element("error-message").textContent, /可编辑/u);
    assert.doesNotMatch(app.element("error-message").textContent, /剪贴板|输入成功/u);
    assert.equal(app.element("typing-input").value, "文字被拒绝");
    app.frame(); await flush();
    assert.equal(app.calls.filter(({ name }) => name === "android_type").length, 1);
  } finally { await app.close(); }
});

test("Rust text panel explains Chinese preparation alongside ASCII keyboard input", () => {
  assert.match(html, /输入中文、英文、数字或符号/u);
  assert.match(html, /首次启用并选中/u);
  assert.match(html, /设备中文输入/u);
  assert.doesNotMatch(html, /文字会写入手机剪贴板/u);
  assert.match(html, /512/u);
});


test("Rust IME acceptance remains distinct from verified target insertion", async () => {
    const app = await textFixture({ typeResponse: () => ({content: [], structuredContent: {
      textTransfer: { mode: "ime", status: "accepted", insertionVerified: false },
    }}) });
    try {
      app.element("typing-input").value = "只提交一次";
      app.click("type-button"); await flush();
      assert.match(app.element("activity").textContent, /输入法已接受文字/u);
      assert.match(app.element("activity").textContent, /请查看手机确认/u);
      assert.doesNotMatch(app.element("activity").textContent, /输入成功|文字已输入/u);
      app.frame(); await flush();
      assert.equal(app.calls.filter(({name}) => name === "android_type").length, 1);
      assert.equal(app.element("typing-input").value, "只提交一次");
    } finally { await app.close(); }
});
