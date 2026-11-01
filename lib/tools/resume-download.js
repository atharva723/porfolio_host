module.exports = {
  name: "get_resume_download",
  label: "Resume download",
  topic: "resume_download",
  suggestion: "Can I download his resume?",
  description: "Link to download his resume as a PDF (always the latest version). Use when a visitor wants to download, save, print or get a copy of the resume or CV.",
  parameters: { type: "object", properties: {} },
  // Only offer the follow-up chip when a download is actually configured.
  suggestWhen: (ctx) => !!ctx.resumeDownload().url,

  async run(_args, ctx) {
    const { url } = ctx.resumeDownload();
    if (!url) {
      return {
        available: false,
        note: "A downloadable resume is not set up right now. His resume details can still be answered here, or he can be contacted directly for a copy.",
      };
    }
    return { available: true, download_pdf: url, note: "Opens the latest version of his resume as a PDF." };
  },
};
