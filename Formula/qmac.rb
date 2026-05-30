class Qmac < Formula
  desc "Self-documenting CLI and MCP server for Quicken For Mac"
  homepage "https://dweekly.github.io/quicken-mac-mcp/"
  url "https://registry.npmjs.org/quicken-mac-mcp/-/quicken-mac-mcp-1.5.0.tgz"
  # TODO: after `npm publish` of 1.5.0, set this to the real checksum:
  #   shasum -a 256 "$(npm pack quicken-mac-mcp@1.5.0 2>/dev/null)"
  sha256 "REPLACE_WITH_1.5.0_TARBALL_SHA256"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # Simple sanity check
    system "#{bin}/qmac", "--version"
    system "#{bin}/quicken-mac-mcp", "--version"
  end
end
