var SerialPort 	= require('serialport');
var gpio     	= require('rpi-gpio');




function parseC02 (buffer) 
{
	return parseInt( buffer.readUInt8(2) * 256 + buffer.readUInt8(3));
}


module.exports = function(RED) {

	var port; 


	function Handle (config) 
	{
		RED.nodes.createNode(this, config);
		const node = this;
		const C02Command = Buffer.from([255, 1, 134, 0, 0, 0, 0, 0, 121])

		node.lastC02 = 0; 
		node.lastPMS = 0;

		if(!port)
		{
			port = new SerialPort('/dev/serial0', { baudRate: 9600});
		}

		function ghettoFlush ()
		{
			if (! (port.read(1))) return;

			var i = 1000;
			var inBuf = port.read(i);
			while (!inBuf)
				inBuf = port.read(i--);
		}

		function muxA (callback)
		{
			gpio.write(22, 1, function()
				{

					gpio.write(35, 0, function()
					{
						gpio.write(22, 0, callback)
					});
				});
		};

		function muxB (callback)
		{
			gpio.write(22, 1, function()
				{
					port.flush( function()
						{
							gpio.write(35, 1, function()
							{
								gpio.write(22, 0, callback)
							});
						});
				});
		};

		function parsePMS (buffer)
		{
				return { pm10: buffer.readUInt8(10) * 256 + buffer.readUInt8(11), 
						 pm25: buffer.readUInt8(12) * 256 + buffer.readUInt8(13), 
						 pm100: buffer.readUInt8(14) * 256 + buffer.readUInt8(15),}

		}

		function readPMS () 
		{
			const inBuf = port.read(32);
			if(!inBuf)	return;

			var last = 66;
			var count = -1;
			for(const b of inBuf)
			{
				if(last == 66 && b == 77) break;
				count++;
				last = b;
			}

			if(count == 0) { return parsePMS(inBuf);};

			const secondary = port.read(32 - count);
			try 
			{
				const fRead = Buffer.concat( [inBuf.slice(count, 32), secondary.slice(0, count)]);
				return parsePMS(fRead);
			}
			catch (e) { return node.lastPMS;};


		}

		function parseC02 (buffer) 
		{
			return parseInt( buffer.readUInt8(2) * 256 + buffer.readUInt8(3));
		}

		function readC02 ()
		{
			var inBuf = port.read(9);
			if(!inBuf) return;

			return parseC02(inBuf);
		}

		function callBack( up = true, count = 0, delay = 2000) 
		{
			if(up)
			{
				muxA(function()
				{
					setTimeout(function()
					{
						node.lastPMS = readPMS();

						ghettoFlush();
						callBack(!up, count + 1, delay);
					}, delay);
				});
			}
			else
			{
				muxB(function()
					{
					port.write(C02Command);
					setTimeout(function()
					{
						port.drain(
						function() {
							node.lastC02 = readC02();
						});

						callBack(!up, count + 1, delay);
					}, delay);
					});
			}
		}

		gpio.setup(22, gpio.DIR_OUT, function()
			{

			gpio.setup(35, gpio.DIR_OUT, function() 
				{

				 callBack();

				});
			}); 



		};




	function C02Sensor (config) 
	{
		RED.nodes.createNode(this, config);
		const node = this;

		node.handle = RED.nodes.getNode(config.handle);
	

		function outRecall ()
		{
			node.send( {payload: node.handle.lastC02});

			setTimeout(function()
				{
					outRecall();

				}, 2000);
		}

		outRecall();

	}

	function PMSSensor (config)
	{
		RED.nodes.createNode(this, config); 
		const node = this;

		node.handle = RED.nodes.getNode(config.handle); 

		function outRecall ()
		{

			setTimeout(function()
				{
					outRecall();

				}, 2000);

			if(node.handle.lastPMS)
			node.send([ {payload: node.handle.lastPMS.pm10}, {payload: node.handle.lastPMS.pm25}, {payload: node.handle.lastPMS.pm100}]);
		}

		outRecall();
	}




	RED.nodes.registerType("mux-handle", Handle);
	RED.nodes.registerType("mux-c02-read", C02Sensor);
	RED.nodes.registerType("mux-PMS-read", PMSSensor);
}
