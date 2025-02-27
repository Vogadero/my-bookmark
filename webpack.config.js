const path = require("path");

module.exports = {
    entry: "./src/extension.ts",
    output: {
        path: path.resolve(__dirname, "dist"),
        filename: "extension.js",
        libraryTarget: "commonjs2",
        devtoolModuleFilenameTemplate: "../[resource-path]",
    },
    target: "node",
    externals: {
        vscode: "commonjs vscode",
        "@resvg/resvg-js-win32-x64-msvc": "commonjs2 @resvg/resvg-js-win32-x64-msvc",
    },
    resolve: {
        extensions: [".ts", ".js", ".node"],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: "ts-loader",
            },
            {
                test: /\.node$/,
                use: "file-loader",
            },
        ],
    },
    optimization: {
        minimize: false,
    },
};
