var exports = module.exports = {};
var {execSync}  = require('child_process');

exports.hardwareSerial = function ()
{
	try
	{
		let stdout = execSync("cat /proc/cpuinfo | grep erial");
		return stdout.toString().split(' ')[1].split('\n')[0];
	}
	catch(e) { return undefined};
}
