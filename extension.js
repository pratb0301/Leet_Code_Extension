const vscode = require('vscode');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const extestcase = async (url) => {
    try {
        const browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--disable-gpu', '--no-sandbox', '--disable-software-rasterizer']
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 128, height: 80 });
        await page.goto(url, { waitUntil: 'networkidle0' });
        
        await page.waitForSelector('.example-block, pre', { timeout: 5000 });
        await page.keyboard.press('Enter');
        await page.keyboard.press('Space');
        
        const content = await page.content();
        const $ = cheerio.load(content);
        await browser.close();

        let groupedTestCases = [];

        const parseValue = (value) => {
            if (typeof value !== 'string') return value;
            value = value.trim();
            
            if (value.startsWith('[') && value.endsWith(']')) {
                try {
                    const arrayValue = JSON.parse(value);
                    return arrayValue.map(item => 
                        typeof item === 'string' && !isNaN(Number(item)) ? Number(item) : item
                    );
                } catch (e) {
                    console.error('Error parsing array:', e);
                    return value;
                }
            }
            
            if (value.startsWith('"') && value.endsWith('"')) {
                return value.slice(1, -1);
            }
            
            if (!isNaN(Number(value))) {
                return Number(value);
            }
            
            return value;
        };

        const extractInputs = (text) => {
            text = text.replace(/^Input:?\s*/i, '').trim();
            
            const varRegex = /(\w+)\s*=\s*("[^"]+"|'[^']+'|\[[^\]]+\]|-?\d+)/g;
            const variables = {};
            let match;
            let hasVariables = false;
            
            while ((match = varRegex.exec(text)) !== null) {
                hasVariables = true;
                const [_, varName, value] = match;
                variables[varName] = parseValue(value);
            }
            
            if (hasVariables) {
                // If we found variables, return them as an array
                return Object.values(variables);
            } else {
                text = text.replace(/^s\s*=\s*/, '').trim();
                return [parseValue(text)];
            }
        };

        $('.example-block').each((_, element) => {
            const $element = $(element);
            
            const inputText = $element.find('p:contains("Input:")').text().trim();
            const outputText = $element.find('p:contains("Output:")').text().trim();
            
            if (inputText && outputText) {
                const inputs = extractInputs(inputText);
                const output = parseValue(outputText.replace(/^Output:?\s*/i, '').trim());
                
                groupedTestCases.push({
                    input: inputs,
                    output: output
                });
            }
        });

        if (groupedTestCases.length === 0) {
            $('pre').each((_, element) => {
                const text = $(element).text().trim();
                const [inputSection, outputSection] = text.split(/Output:/i).map(s => s.trim());
                
                if (inputSection && outputSection) {
                    const inputs = extractInputs(inputSection);
                    const output = parseValue(outputSection.split('\n')[0].trim());
                    
                    groupedTestCases.push({
                        input: inputs,
                        output: output
                    });
                }
            });
        }

        if (groupedTestCases.length === 0) {
            console.log('No test cases found. Raw content:', content);
            vscode.window.showWarningMessage('No test cases found on the page.');
        } else {
            console.log('Extracted test cases:', groupedTestCases);
            generateSampleCode(groupedTestCases);
        }
        
        return groupedTestCases;
    } catch (error) {
        console.error('Error extracting test cases:', error);
        vscode.window.showErrorMessage('Failed to extract test cases. See console for details.');
        return [];
    }
};
const generateSampleCode = async (testCases) => {
    console.log('Received test cases:', JSON.stringify(testCases, null, 2));

    if (!Array.isArray(testCases) || testCases.length === 0) {
        console.error('Test cases is not an array or is empty');
        vscode.window.showErrorMessage('Invalid or empty test cases provided.');
        return;
    }

    const isValidTestCase = (tc) => {
        console.log('Validating test case:', tc);
        return tc && 
               typeof tc === 'object' &&
               'input' in tc &&
               'output' in tc &&
               Array.isArray(tc.input);
    };

    const invalidTestCases = testCases.filter(tc => !isValidTestCase(tc));
    if (invalidTestCases.length > 0) {
        console.error('Invalid test cases found:', invalidTestCases);
        vscode.window.showErrorMessage('Invalid test case format. Each test case must have input and output fields.');
        return;
    }

    const SUPPORTED_LANGUAGES = {
        'JavaScript': { extension: 'js', generator: generateJavaScriptCode },
        'Python': { extension: 'py', generator: generatePythonCode },
        'C++': { extension: 'cpp', generator: generateCppCode },
        'Java': { extension: 'java', generator: generateJavaCode }
    };

    const language = await vscode.window.showQuickPick(
        Object.keys(SUPPORTED_LANGUAGES),
        { 
            placeHolder: 'Select the language for the sample code',
            title: 'Code Template Generator'
        }
    );

    if (!language) {
        return;
    }

    try {
        const { extension, generator } = SUPPORTED_LANGUAGES[language];
        const code = generator(testCases);
        const fileName = `solution.${extension}`;

        const document = await vscode.workspace.openTextDocument({ 
            content: code, 
            language: extension 
        });
        await vscode.window.showTextDocument(document);
        vscode.window.showInformationMessage(`Sample code generated in ${fileName}`);
    } catch (error) {
        console.error('Error generating code:', error);
        vscode.window.showErrorMessage(`Failed to generate ${language} code: ${error.message}`);
    }
};

const getTypeBasedParam = (value, index, isTyped = false, isCpp = false) => {
    if (Array.isArray(value)) {
        if (isCpp) {
            if (value.length > 0) {
                if (typeof value[0] === 'number') {
                    return `vector<int> vec${index}`;
                } else if (typeof value[0] === 'string') {
                    return `vector<string> vec${index}`;
                } else if (typeof value[0] === 'boolean') {
                    return `vector<bool> vec${index}`;
                }
                return `vector<auto> vec${index}`;
            }
            return `vector<int> vec${index}`;
        }
        
        if (value.length > 0 && typeof value[0] === 'number') {
            return isTyped ? `int[] arr${index}` : `arr${index}`;
        }
        return isTyped ? `Object[] arr${index}` : `arr${index}`;
    }
    
    const typeMap = {
        'number': isTyped ? 'int' : 'num',
        'string': isTyped ? (isCpp ? 'string' : 'String') : 'str',
        'boolean': isTyped ? 'bool' : 'bool'
    };
    
    const type = typeof value;
    const baseType = typeMap[type] || (isTyped ? 'Object' : 'param');
    return isTyped ? `${baseType} param${index}` : `${baseType}${index}`;
};

const generateJavaScriptCode = (testCases) => {
    const params = testCases[0].input.map((value, index) => 
        getTypeBasedParam(value, index));

    const functionBody = `
    // TODO: Implement your solution here
    // Parameters:
    ${params.map((param, i) => `// ${param}: ${typeof testCases[0].input[i]}`).join('\n    ')}
    
    // Return type: ${typeof testCases[0].output}
    return null;`;

    const code = [
        '/**',
        ' * Solution template',
        ` * @param {${params.map((_, i) => `*`).join(', ')}} params`,
        ' * @return {*}',
        ' */',
        `function solution(${params.join(', ')}) {${functionBody}\n}`,
        '',
        '// Test cases',
        ...testCases.map((testCase, i) => [
            `console.log('Test case ${i + 1}:');`,
            `const result${i + 1} = solution(${testCase.input.map(val => 
                JSON.stringify(val)).join(', ')});`,
            `console.log('Expected:', ${JSON.stringify(testCase.output)});`,
            `console.log('Result:', result${i + 1});`,
            `console.log('Matches:', JSON.stringify(result${i + 1}) === JSON.stringify(${JSON.stringify(testCase.output)}));`,
            `console.log('---');`,
            ''
        ]).flat()
    ].join('\n');

    return code;
};

const generatePythonCode = (testCases) => {
    const params = testCases[0].input.map((value, index) => 
        getTypeBasedParam(value, index));

    const typeHints = testCases[0].input.map((value, index) => {
        if (Array.isArray(value)) return 'List[int]';
        return {
            'number': 'int',
            'string': 'str',
            'boolean': 'bool'
        }[typeof value] || 'Any';
    });

    const code = [
        'from typing import List, Any',
        '',
        `def solution(${params.map((param, i) => `${param}: ${typeHints[i]}`).join(', ')}) -> Any:`,
        '    """',
        '    Solution template',
        '    ',
        '    Args:',
        params.map((param, i) => `        ${param}: ${typeHints[i]}`).join('\n'),
        '    ',
        '    Returns:',
        '        The solution to the problem',
        '    """',
        '    # TODO: Implement your solution here',
        '    pass',
        '',
        '# Test cases',
        ...testCases.map((testCase, i) => [
            `print(f"Test case ${i + 1}:")`,
            `result${i + 1} = solution(${testCase.input.map(val => 
                JSON.stringify(val)).join(', ')})`,
            `print(f"Expected: {${JSON.stringify(testCase.output)}}")`,
            `print(f"Result: {result${i + 1}}")`,
            `print(f"Matches: {result${i + 1} == ${JSON.stringify(testCase.output)}}")`,
            'print("---")',
            ''
        ]).flat()
    ].join('\n');

    return code;
};
const generateCppCode = (testCases) => {
    const params = testCases[0].input.map((value, index) => 
        getTypeBasedParam(value, index, true, true));

    // Determine output type from first test case
    const isOutputVector = Array.isArray(testCases[0].output);
    const getOutputType = (output) => {
        if (Array.isArray(output)) {
            if (output.length > 0) {
                if (typeof output[0] === 'number') return 'vector<int>';
                if (typeof output[0] === 'string') return 'vector<string>';
                return 'vector<int>';
            }
            return 'vector<int>';
        }
        if (typeof output === 'number') return 'int';
        if (typeof output === 'string') return 'string';
        return 'int';
    };

    const outputType = getOutputType(testCases[0].output);

    // Helper function to format input values
    const formatValue = (val) => {
        if (Array.isArray(val)) {
            const type = typeof val[0] === 'string' ? 'string' : 'int';
            return `vector<${type}>{${val.map(v => formatValue(v)).join(', ')}}`;
        }
        if (typeof val === 'string') {
            return `"${val}"`;
        }
        return val;
    };

    const code = [
        '#include <iostream>',
        '#include <vector>',
        '#include <string>',
        '#include <type_traits>',
        '',
        'using namespace std;',
        '',
        'void printVector(const vector<int>& vec) {',
        '    cout << "{";',
        '    for (size_t i = 0; i < vec.size(); ++i) {',
        '        if (i > 0) cout << ", ";',
        '        cout << vec[i];',
        '    }',
        '    cout << "}";',
        '}',
        '',
        'void printVector(const vector<string>& vec) {',
        '    cout << "{";',
        '    for (size_t i = 0; i < vec.size(); ++i) {',
        '        if (i > 0) cout << ", ";',
        '        cout << "\\"" << vec[i] << "\\"";',
        '    }',
        '    cout << "}";',
        '}',
        '',
        '// Solution function declaration',
        `${outputType} solution(${params.join(', ')}) {`,
        '    // TODO: Implement your solution here',
        '    // Parameters:',
        params.map((param, i) => `    // ${param}`).join('\n'),
        isOutputVector ? '    return {};' : 
            (outputType === 'string' ? '    return "";' : '    return 0;'),
        '}',
        '',
        'template<typename T>',
        'void printResult(const T& result) {',
        '    cout << result;',
        '}',
        '',
        'template<>',
        'void printResult(const vector<int>& result) {',
        '    printVector(result);',
        '}',
        '',
        'template<>',
        'void printResult(const vector<string>& result) {',
        '    printVector(result);',
        '}',
        '',
        'bool compareVectors(const vector<int>& a, const vector<int>& b) {',
        '    if (a.size() != b.size()) return false;',
        '    for (size_t i = 0; i < a.size(); ++i) {',
        '        if (a[i] != b[i]) return false;',
        '    }',
        '    return true;',
        '}',
        '',
        'bool compareVectors(const vector<string>& a, const vector<string>& b) {',
        '    if (a.size() != b.size()) return false;',
        '    for (size_t i = 0; i < a.size(); ++i) {',
        '        if (a[i] != b[i]) return false;',
        '    }',
        '    return true;',
        '}',
        '',
        'template<typename T>',
        'bool compareResults(const T& result, const T& expected) {',
        '    return result == expected;',
        '}',
        '',
        'template<>',
        'bool compareResults(const vector<int>& result, const vector<int>& expected) {',
        '    return compareVectors(result, expected);',
        '}',
        '',
        'template<>',
        'bool compareResults(const vector<string>& result, const vector<string>& expected) {',
        '    return compareVectors(result, expected);',
        '}',
        '',
        'int main() {',
        '    // Test cases',
        ...testCases.map((testCase, i) => {
            const formattedInputs = testCase.input.map(val => formatValue(val)).join(', ');
            const formattedOutput = formatValue(testCase.output);

            return [
                `    cout << "Test case ${i + 1}:" << endl;`,
                `    ${outputType} result${i + 1} = solution(${formattedInputs});`,
                `    ${outputType} expected${i + 1} = ${formattedOutput};`,
                `    cout << "Expected: "; printResult(expected${i + 1}); cout << endl;`,
                `    cout << "Result: "; printResult(result${i + 1}); cout << endl;`,
                `    cout << "Matches: " << boolalpha << compareResults(result${i + 1}, expected${i + 1});`,
                `    cout << endl << "---" << endl;`,
                ''
            ];
        }).flat(),
        '    return 0;',
        '}'
    ].join('\n');

    return code;
};
const generateJavaCode = (testCases) => {
    const params = testCases[0].input.map((value, index) => 
        getTypeBasedParam(value, index, true));

    const code = [
        'import java.util.Arrays;',
        '',
        'public class Solution {',
        '    /**',
        '     * Solution template',
        '     */',
        `    public static Object solution(${params.join(', ')}) {`,
        '        // TODO: Implement your solution here',
        '        // Parameters:',
        params.map((param, i) => `        // ${param}`).join('\n'),
        '        return null;',
        '    }',
        '',
        '    private static boolean compareArrays(Object a, Object b) {',
        '        if (a instanceof int[] && b instanceof int[]) {',
        '            return Arrays.equals((int[]) a, (int[]) b);',
        '        }',
        '        return a.equals(b);',
        '    }',
        '',
        '    public static void main(String[] args) {',
        '        // Test cases',
        ...testCases.map((testCase, i) => [
            `        System.out.println("Test case ${i + 1}:");`,
            `        Object result${i + 1} = solution(${testCase.input.map(val => 
                Array.isArray(val) ? 
                    `new int[]{${val.join(', ')}}` :
                    JSON.stringify(val)).join(', ')});`,
            `        Object expected${i + 1} = ${Array.isArray(testCase.output) ? 
                `new int[]{${testCase.output.join(', ')}}` : 
                JSON.stringify(testCase.output)};`,
            `        System.out.println("Expected: " + ${Array.isArray(testCase.output) ? 
                `Arrays.toString((int[]) expected${i + 1})` : 
                `expected${i + 1}`});`,
            `        System.out.println("Result: " + ${Array.isArray(testCase.output) ? 
                `Arrays.toString((int[]) result${i + 1})` : 
                `result${i + 1}`});`,
            `        System.out.println("Matches: " + compareArrays(result${i + 1}, expected${i + 1}));`,
            `        System.out.println("---");`,
            ''
        ]).flat(),
        '    }',
        '}'
    ].join('\n');

    return code;
};
const searchshit = async () => {
    const query = await vscode.window.showInputBox({
        prompt: 'Enter a LeetCode problem keyword (example: two sum)',
        placeHolder: 'Search LeetCode problems...'
    });

    if (!query) {
        vscode.window.showErrorMessage('Search query cannot be empty.');
        return;
    }

    try {
        const browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--disable-gpu', '--no-sandbox', '--disable-software-rasterizer']
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 128, height: 80 });
        await page.goto(`https://leetcode.com/problemset/all/?search=${query.trim().replace(/ /g, '+')}&page=1}`, { waitUntil: 'networkidle0' });

        await page.keyboard.press('Enter');
        await page.keyboard.press('Space');
        await page.waitForFunction(() => {
            return document.querySelector('a.h-5[href*="/problems/"]') !== null;
        }, { timeout: 1000 });

        const content = await page.content();
        await browser.close();
        const $ = cheerio.load(content);
        const problems = [];
        $('a.h-5[href*="/problems/"]').each((index, element) => {
            const title = $(element).text().trim();
            const link = $(element).attr('href');
            if (title && link) {
                problems.push({ title, link: `https://leetcode.com${link}` });
            }
        });
        problems.shift();
        if (problems.length === 0) {
            vscode.window.showErrorMessage('No problems found.');
        } else {
            vscode.window.showInformationMessage(`Found ${problems.length} problems.`);
            console.log(problems);
            const qselect = await vscode.window.showQuickPick(problems.map(problem => ({ label: problem.title, detail: problem.link })), { placeHolder: 'select kro' });
            if (!qselect) {
                vscode.window.showErrorMessage('Nothing was picked');
                return;
            } else {
                vscode.window.showInformationMessage(`You picked ${qselect.label}`);
                extestcase(qselect.detail);
            }
        }
    } catch (error) {
        console.log(error);
        vscode.window.showErrorMessage('Failed to search problems');
    }
};

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "cphleet" is now active!');

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json
    const disposable = vscode.commands.registerCommand('cphleet.helloWorld', () => {
        // The code you place here will be executed every time your command is executed
        // Display a message box to the user
        vscode.window.showInformationMessage('Hello World from cphleet!');
        searchshit();
    });
    context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
    activate,
    deactivate
};
